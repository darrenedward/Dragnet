/**
 * Skeptic pass — adversarial adjudication of primary-model findings by
 * the fallback chat model.
 *
 * After the primary agentic loop produces findings and the existing
 * deterministic verifier (parent module) runs, this module sends a single
 * batched prompt to the fallback chat model. The prompt includes the
 * ACTUAL file contents at each finding's cited lines (read from disk via
 * `loadFileContent`, not from the model's explanation). The fallback
 * returns structured verdicts (confirm / downgrade / reject) that the
 * scan engine applies before persistence.
 *
 * Contract:
 *  - Never throws. On any failure (LLM error, parse error, etc.) returns
 *    an empty Map and emits a single console.warn. Findings without a
 *    verdict in the result map are unaffected — they persist as the
 *    primary model produced them.
 *  - Bounds prompt size: caps at SKEPTIC_BATCH_CAP findings per call.
 *    Overflow gets no verdict (empty Map entry means "skeptic didn't
 *    reach this finding").
 *  - All file reads go through `loadFileContent` (disk-first, PrFile
 *    fallback) — same path as the deterministic verifier.
 */

import type { CandidateFinding } from "../findingVerifier";
import { loadFileContent } from "../findingVerifier";
import type { ChainEntry } from "@/src/lib/llmClient";
import type { SkepticSettings } from "@/src/lib/skepticConfig";

export interface SkepticVerdict {
  verdict: "confirmed" | "downgraded" | "rejected";
  note: string;
  /**
   * Target severity — only present on "downgraded" verdicts. Validated
   * against VALID_SEVERITIES; on invalid/missing the scan engine steps
   * down one rung from the finding's current severity.
   */
  newSeverity?: string;
}

const SKEPTIC_BATCH_CAP = 30;
const VALID_VERDICTS = new Set(["confirmed", "downgraded", "rejected"]);
const VALID_SEVERITIES = new Set(["blocker", "warning", "suggestion"]);
const SEVERITY_RANK: Record<string, number> = {
  blocker: 3,
  warning: 2,
  suggestion: 1,
};
const CONTEXT_WINDOW = 10; // lines either side of the cited line

/**
 * Sources emitted by deterministic tools. Never candidates for LLM
 * adjudication — they're ground truth from a tool the user trusts.
 */
const DETERMINISTIC_SOURCES: ReadonlySet<string> = new Set([
  "tsc",
  "eslint",
  "runner",
]);

interface GateResult {
  /** Findings that cleared every gate. */
  batch: CandidateFinding[];
  /** Findings filtered out by any gate. */
  excludedCount: number;
}

/**
 * Apply the four skeptic gates in order:
 *  1. Deterministic skip (source = tsc/eslint/runner)
 *  2. Severity whitelist
 *  3. Confidence floor (absent = passes)
 *  4. Category whitelist (case-insensitive)
 *
 * Findings that fail any gate are excluded — they keep their existing
 * verification state and never reach the fallback model.
 */
export function applyGate(
  candidates: CandidateFinding[],
  settings: SkepticSettings,
): GateResult {
  const severitySet: Set<string> = new Set(settings.gateSeverity);
  const categorySet = new Set(
    settings.gateCategories.map((c) => c.toLowerCase()),
  );

  const batch: CandidateFinding[] = [];
  let excludedCount = 0;
  for (const candidate of candidates) {
    if (settings.skipDeterministic) {
      const source = candidate.source ?? "llm";
      if (DETERMINISTIC_SOURCES.has(source)) {
        excludedCount++;
        continue;
      }
    }
    if (!severitySet.has(candidate.severity)) {
      excludedCount++;
      continue;
    }
    if (
      typeof candidate.confidence === "number" &&
      candidate.confidence < settings.gateMinConfidence
    ) {
      excludedCount++;
      continue;
    }
    if (!categorySet.has(candidate.category.toLowerCase())) {
      excludedCount++;
      continue;
    }
    batch.push(candidate);
  }
  return { batch, excludedCount };
}

const SYSTEM_PROMPT = `You are a skeptical code review auditor. A primary review model produced the findings below. Your job is to challenge each one using ONLY the actual file contents provided — not the model's explanation.

For every finding, return one verdict:
- "confirmed": cited lines genuinely exhibit the issue
- "downgraded": real issue but severity too high, or partially mitigated by surrounding code
- "rejected": cited lines do NOT exhibit the issue (false positive, hallucinated line, wrong file, already-fixed)

Rules:
- Ground truth is the provided file contents, not the explanation
- Empty/missing code block -> "rejected" with note "cited code not available"
- Off-by-a-few-lines but real nearby -> "confirmed" is acceptable
- Be adversarial: assume the primary model was wrong until the code proves it right

Respond with JSON only, no markdown fences, no prose:
{"verdicts":[{"id":"<uuid>","verdict":"confirmed|downgraded|rejected","severity":"blocker|warning|suggestion","note":"<one sentence, max 200 chars>"}]}

"severity" is required ONLY on "downgraded" verdicts (the target severity); omit otherwise.`;

/**
 * Run a single batched adversarial pass through the fallback model.
 *
 * @param candidates Findings to adjudicate, each with a stable id.
 * @param fallbackEntry The fallback ChainEntry (index 1 of getChatChain).
 *   Caller is responsible for ensuring this is the fallback, not primary.
 * @param repoPath Local repo path for disk reads. null for remote-volume
 *   repos (falls back to PrFile table reads inside loadFileContent).
 * @param prId PR id for PrFile lookup fallback.
 * @param settings Gate configuration. Findings that don't clear the gate
 *   are filtered out before the LLM is called — they receive no verdict
 *   and persist as the primary model produced them.
 * @returns Map keyed by candidate.id. Absent entries = skeptic didn't
 *   reach that finding (no change applied).
 */
export async function runSkepticPass(
  candidates: CandidateFinding[],
  fallbackEntry: ChainEntry,
  repoPath: string | null,
  prId: string,
  settings: SkepticSettings,
): Promise<Map<string, SkepticVerdict>> {
  const results = new Map<string, SkepticVerdict>();
  if (candidates.length === 0) return results;

  const gated = applyGate(candidates, settings);
  if (gated.batch.length === 0) {
    console.log(
      `[skeptic] gate filtered out all ${gated.excludedCount} findings — skipping LLM call`,
    );
    return results;
  }
  if (gated.excludedCount > 0) {
    console.log(
      `[skeptic] gate included ${gated.batch.length} of ${candidates.length} findings (${gated.excludedCount} filtered)`,
    );
  }

  const batch = gated.batch.slice(0, SKEPTIC_BATCH_CAP);
  const truncatedCount = gated.batch.length - batch.length;
  if (truncatedCount > 0) {
    console.warn(
      `[skeptic] truncating batch to ${SKEPTIC_BATCH_CAP} of ${gated.batch.length} findings (cap)`,
    );
  }

  try {
    const userPrompt = await buildUserPrompt(batch, repoPath, prId);
    const completion = await fallbackEntry.client.chat.completions.create({
      model: fallbackEntry.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 4096,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseVerdicts(raw);
    if (!parsed) {
      console.warn(
        `[skeptic] failed to parse JSON verdicts from fallback model — no findings adjudicated. Raw: ${raw.slice(0, 200)}`,
      );
      return results;
    }

    const candidateIds = new Set(batch.map((c) => c.id));
    let discarded = 0;
    for (const entry of parsed.verdicts) {
      const validated = validateEntry(entry, candidateIds);
      if (!validated) {
        discarded++;
        continue;
      }
      const note = (entry.note ?? "").toString().slice(0, 200);
      const verdict: SkepticVerdict = {
        verdict: validated.verdict,
        note: note || `skeptic: ${validated.verdict}`,
      };
      if (validated.verdict === "downgraded") {
        verdict.newSeverity = validated.severity;
      }
      results.set(validated.id, verdict);
    }

    if (discarded > 0) {
      console.warn(
        `[skeptic] discarded ${discarded} invalid verdict entries (unknown id, bad enum, or missing severity on downgrade)`,
      );
    }
  } catch (err) {
    console.warn(
      `[skeptic] pass failed (${fallbackEntry.name}/${fallbackEntry.model}):`,
      (err as Error).message?.slice(0, 200),
    );
  }

  return results;
}

interface RawVerdictEntry {
  id?: unknown;
  verdict?: unknown;
  severity?: unknown;
  note?: unknown;
}

interface ParsedVerdicts {
  verdicts: RawVerdictEntry[];
}

function parseVerdicts(raw: string): ParsedVerdicts | null {
  if (!raw) return null;
  const cleaned = stripThinkBlocks(raw).trim();
  if (!cleaned) return null;

  const candidates: string[] = [];
  // Strip markdown fences if present.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    candidates.push(fenceMatch[1].trim());
  }
  candidates.push(cleaned);
  const jsonObjectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch && jsonObjectMatch[0] !== cleaned) {
    candidates.push(jsonObjectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray((parsed as ParsedVerdicts).verdicts)) {
        return parsed as ParsedVerdicts;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function validateEntry(
  entry: RawVerdictEntry,
  knownIds: Set<string>,
): { id: string; verdict: SkepticVerdict["verdict"]; severity?: string } | null {
  if (typeof entry.id !== "string" || !knownIds.has(entry.id)) return null;
  if (typeof entry.verdict !== "string" || !VALID_VERDICTS.has(entry.verdict)) {
    return null;
  }
  const result: { id: string; verdict: SkepticVerdict["verdict"]; severity?: string } = {
    id: entry.id,
    verdict: entry.verdict as SkepticVerdict["verdict"],
  };
  if (entry.verdict === "downgraded") {
    if (
      typeof entry.severity === "string" &&
      VALID_SEVERITIES.has(entry.severity)
    ) {
      result.severity = entry.severity;
    }
    // Missing/invalid severity on downgrade is OK — caller falls back to
    // step-down-one-rung. Don't discard the whole verdict.
  }
  return result;
}

async function buildUserPrompt(
  batch: CandidateFinding[],
  repoPath: string | null,
  prId: string,
): Promise<string> {
  const findingsBlock: string[] = [];
  const codeBlock: string[] = [];

  batch.forEach((f, idx) => {
    findingsBlock.push(
      `[${idx + 1}] id: ${f.id}`,
      `    category: ${f.category}`,
      `    severity: ${f.severity}`,
      `    file: ${f.filename}:${f.line ?? "?"}`,
      `    explanation: ${f.explanation}`,
      "",
    );
  });

  // Load file contents for each finding (dedupe by filename where possible).
  const fileCache = new Map<string, string | null>();
  for (const f of batch) {
    const cacheKey = f.filename;
    let content: string | null;
    if (fileCache.has(cacheKey)) {
      content = fileCache.get(cacheKey) ?? null;
    } else {
      content = repoPath ? await loadFileContent(f.filename, repoPath, prId) : null;
      fileCache.set(cacheKey, content);
    }
    const sliced = sliceWindow(content, f.line);
    if (sliced === null) {
      codeBlock.push(`--- ${f.filename}:${f.line ?? "?"} (load failed) ---`);
    } else if (sliced === "") {
      codeBlock.push(`--- ${f.filename}:${f.line ?? "?"} (cited line out of bounds) ---`);
    } else {
      codeBlock.push(`--- ${f.filename}:${f.line ?? "?"} ---`);
      codeBlock.push(sliced);
    }
    codeBlock.push("");
  }

  return [
    `Finding count: ${batch.length}`,
    "",
    "=== FINDINGS ===",
    ...findingsBlock,
    "=== CODE AT CITED LINES ===",
    ...codeBlock,
    `Return JSON verdicts for all ${batch.length} findings. Match each by id.`,
  ].join("\n");
}

/**
 * Slice a window of ±CONTEXT_WINDOW lines around the cited line. Returns
 * the slice with line numbers prefixed, or null if content is null (load
 * failed), or "" if the cited line is out of bounds.
 */
function sliceWindow(content: string | null, line: number | null | undefined): string | null {
  if (content === null) return null;
  if (!line || line < 1) return content.split("\n").slice(0, 20).join("\n");
  const lines = content.split("\n");
  if (line > lines.length) return "";
  const start = Math.max(0, line - 1 - CONTEXT_WINDOW);
  const end = Math.min(lines.length, line + CONTEXT_WINDOW);
  return lines
    .slice(start, end)
    .map((text, offset) => `${start + offset + 1}| ${text}`)
    .join("\n");
}

function stripThinkBlocks(s: string): string {
  return s
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think[^>]*>[\s\S]*$/gi, "");
}

/**
 * Step a severity down one rung. Used as the fallback when the LLM omits
 * or sends an invalid target severity on a "downgraded" verdict.
 */
export function stepSeverityDown(currentSeverity: string): string {
  const rank = SEVERITY_RANK[currentSeverity] ?? 1;
  if (rank <= 1) return "suggestion";
  if (rank === 3) return "warning";
  return "suggestion";
}
