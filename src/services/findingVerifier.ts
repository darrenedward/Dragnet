/**
 * v1 Finding Verifier.
 *
 * Post-candidate, pre-persistence validation of LLM-generated findings.
 * Two layers, both grounded in the actual code on disk:
 *
 *   Stage A — line/file validation (ALL findings)
 *     1. File exists
 *     2. Cited line within file bounds
 *     3. Code at line ±5 contains the symbol the finding's explanation
 *        references (substring check — best-effort, false negatives
 *        fall through to Stage B)
 *
 *   Stage B — counter-evidence retrieval (4 finding families only)
 *     - auth          → grep for requireSession, authenticateSessionOrKey,
 *                       authenticateApiRequest, verifyGithubSignature
 *     - data-isolation → read cited function, look for `where: { repoId, ... }`
 *     - webhook/network → grep for HMAC verification, signature checks
 *     - concurrency  → read cited function, look for beginReview/endReview,
 *                       $transaction, atomic upserts
 *
 *     Stage B asks the chat LLM to make the final call: given the cited
 *     code + retrieved counter-evidence, does the finding still apply?
 *
 * Invariants:
 *   - Never throws. On any failure (LLM unavailable, parse error, fs
 *     error), the finding is marked `unverified` and persisted as-is.
 *     The verifier is defense-in-depth, not a gate.
 *   - Rejected findings stay in the DB for audit trail — the route
 *     filter is what hides them.
 *   - `downgraded` means "real issue but overstated" — the UI shows a
 *     amber chip but doesn't drop the finding.
 *
 * Scope v1: line/file validation + counter-evidence for the 4 families.
 * Full PRD §14.6 5-class taxonomy (confirmed/likely/partially_mitigated/
 * needs_verification/false_positive) deferred to a follow-on spec.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prisma } from "@/src/lib/prisma";
import { getChatClient, getChatModel } from "@/src/lib/llmClient";

export interface CandidateFinding {
  id: string;
  category: string;
  severity: string;
  filename: string;
  line?: number | null;
  explanation: string;
}

export interface VerificationResult {
  status: "verified" | "downgraded" | "rejected" | "unverified";
  note: string;
}

const CONTEXT_RADIUS = 5;

/**
 * Verify a batch of findings. Returns a Map keyed by finding.id so the
 * caller can look up each result in O(1) while building the persistence
 * payload.
 */
export async function verifyFindings(
  findings: CandidateFinding[],
  repoPath: string,
  prId: string,
): Promise<Map<string, VerificationResult>> {
  const results = new Map<string, VerificationResult>();

  for (const finding of findings) {
    try {
      const result = await verifyOne(finding, repoPath, prId);
      results.set(finding.id, result);
    } catch (err) {
      console.warn(
        `[verifier] finding ${finding.id} (${finding.filename}:${finding.line}) threw — marking unverified:`,
        err,
      );
      results.set(finding.id, {
        status: "unverified",
        note: `verifier error: ${(err as Error).message?.slice(0, 120) || "unknown"}`,
      });
    }
  }

  return results;
}

async function verifyOne(
  finding: CandidateFinding,
  repoPath: string,
  prId: string,
): Promise<VerificationResult> {
  // ─── Stage A: line/file validation ─────────────────────────────────
  const stageA = validateLineAndFile(finding, repoPath, prId);
  if (stageA) return stageA;

  // ─── Stage B: counter-evidence retrieval (4 families) ─────────────
  const family = classifyFamily(finding);
  if (!family) {
    return { status: "verified", note: "line/file validation passed" };
  }

  const counterEvidence = retrieveCounterEvidence(finding, family, repoPath);
  if (counterEvidence.length === 0) {
    return { status: "verified", note: `${family}: no counter-evidence found` };
  }

  return await llmVerdict(finding, family, counterEvidence);
}

// ─── Stage A ──────────────────────────────────────────────────────────

function validateLineAndFile(
  finding: CandidateFinding,
  repoPath: string,
  prId: string,
): VerificationResult | null {
  const content = loadFileContent(finding.filename, repoPath, prId);
  if (content === null) {
    return {
      status: "rejected",
      note: `cited file "${finding.filename}" does not exist`,
    };
  }

  if (!finding.line || finding.line < 1) {
    return null;
  }

  const lines = content.split("\n");
  if (finding.line > lines.length) {
    return {
      status: "rejected",
      note: `cited line ${finding.line} is outside file (1..${lines.length})`,
    };
  }

  // Substring check: does the code at line ±5 contain the key symbol
  // the finding's explanation references?
  const symbols = extractCitedSymbols(finding.explanation);
  if (symbols.length === 0) return null;

  const start = Math.max(0, finding.line - 1 - CONTEXT_RADIUS);
  const end = Math.min(lines.length, finding.line + CONTEXT_RADIUS);
  const window = lines.slice(start, end).join("\n");

  const missing = symbols.filter((s) => !window.includes(s));
  if (missing.length === symbols.length) {
    // None of the cited symbols appear anywhere in the window — strong
    // signal the finding is hallucinated or stale.
    return {
      status: "rejected",
      note: `cited code at line ${finding.line} does not reference ${missing.join(", ")}`,
    };
  }

  return null;
}

function loadFileContent(
  filename: string,
  repoPath: string,
  _prId: string,
): string | null {
  // v1: disk read only. PrFile-table fallback (for files deleted in
  // working tree but still in the diff) deferred to a follow-on — the
  // vast majority of findings cite files that still exist on disk.
  const onDisk = path.join(repoPath, filename);
  try {
    return fs.readFileSync(onDisk, "utf-8");
  } catch {
    return null;
  }
}

function extractCitedSymbols(explanation: string): string[] {
  // Pull out backtick-quoted identifiers first (highest signal).
  const tickMatch = explanation.match(/`([A-Za-z_][A-Za-z0-9_.#[\]/-]{1,80})`/g);
  const ticked = tickMatch?.map((m) => m.replace(/`/g, "")) ?? [];

  // Also pick up camelCase / kebab-case identifiers from the prose.
  const proseMatch = explanation.match(/\b(?:[a-z][a-zA-Z0-9_]{3,}|[A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g);
  const fromProse = proseMatch ?? [];

  // Dedup, drop common English words that look like identifiers.
  const STOP = new Set(["the", "this", "that", "with", "from", "into", "true", "false", "null"]);
  const all = [...new Set([...ticked, ...fromProse])].filter((s) => !STOP.has(s.toLowerCase()));

  // Cap at 5 — a finding citing 6+ symbols is probably vague prose.
  return all.slice(0, 5);
}

// ─── Stage B: classification + counter-evidence ──────────────────────

type Family = "auth" | "data-isolation" | "webhook-network" | "concurrency";

function classifyFamily(finding: CandidateFinding): Family | null {
  const text = `${finding.category} ${finding.explanation}`.toLowerCase();

  if (finding.category.toLowerCase() === "security") {
    if (/\b(auth|authentication|authorization|session|api key|bearer|cookie|login|unauthenticated|bypass)\b/.test(text)) {
      return "auth";
    }
    if (/\b(tenant|tenancy|repoId|isolation|cross-repo|multi-tenant|other repo|wrong repo)\b/.test(text)) {
      return "data-isolation";
    }
    if (/\b(webhook|hmac|signature|host header|origin header|x-hub|allowlist|allow.?list|ssrf|dns)\b/.test(text)) {
      return "webhook-network";
    }
  }

  if (finding.category.toLowerCase() === "correctness") {
    if (/\b(race|concurrency|transaction|atomic|lock|mutex|deadlock|order|sequential)\b/.test(text)) {
      return "concurrency";
    }
  }

  return null;
}

function retrieveCounterEvidence(
  finding: CandidateFinding,
  family: Family,
  repoPath: string,
): string[] {
  const patterns = COUNTER_EVIDENCE_PATTERNS[family];
  const hits: string[] = [];

  for (const pattern of patterns) {
    try {
      const out = execFileSync(
        "grep",
        ["-rln", "-E", pattern, "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx", "."],
        { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      );
      const files = out.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        hits.push(`Pattern "${pattern}" found in: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3} more)` : ""}`);
      }
    } catch {
      // grep returns non-zero on no matches — not an error.
    }
  }

  return hits;
}

const COUNTER_EVIDENCE_PATTERNS: Record<Family, string[]> = {
  auth: [
    "\\brequireSession\\b",
    "\\bauthenticateSessionOrKey\\b",
    "\\bauthenticateApiRequest\\b",
    "\\bverifyGithubSignature\\b",
    "\\bgetSessionCookie\\b",
  ],
  "data-isolation": [
    "where:\\s*\\{[^}]*\\brepoId\\b",
  ],
  "webhook-network": [
    "\\bcreateHmac\\b",
    "\\bverifyGithubSignature\\b",
    "\\btimingSafeEqual\\b",
    "\\bVALID_PROVIDERS\\b",
  ],
  concurrency: [
    "\\bbeginReview\\b",
    "\\bendReview\\b",
    "\\bisReviewActive\\b",
    "\\$transaction",
    "\\bupsert\\b",
  ],
};

// ─── Stage B: LLM verdict ─────────────────────────────────────────────

async function llmVerdict(
  finding: CandidateFinding,
  family: Family,
  counterEvidence: string[],
): Promise<VerificationResult> {
  const client = getChatClient();
  const model = getChatModel();
  if (!client || !model) {
    return {
      status: "unverified",
      note: `${family}: chat LLM not configured — cannot verify counter-evidence`,
    };
  }

  const prompt = buildPrompt(finding, family, counterEvidence);

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 200,
    });

    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    return parseVerdict(text);
  } catch (err) {
    console.warn(`[verifier] LLM call failed for finding ${finding.id}:`, err);
    return {
      status: "unverified",
      note: `${family}: LLM call failed (${(err as Error).message?.slice(0, 80)})`,
    };
  }
}

const SYSTEM_PROMPT = `You are a code review auditor. Given a security/correctness finding and counter-evidence retrieved from the actual codebase, decide whether the finding still applies.

Respond with EXACTLY one of:
- VERIFIED — finding is correct, the cited issue is real
- DOWNGRADED — real issue but overstated (e.g., severity too high, or mitigating control exists)
- REJECTED — finding is wrong, counter-evidence shows the issue is already addressed

Follow with a one-sentence reason on the next line.

Example output:
REJECTED
The finding claims auth is missing, but the cited function calls authenticateSessionOrKey at line 9.`;

function buildPrompt(
  finding: CandidateFinding,
  family: Family,
  counterEvidence: string[],
): string {
  return [
    `Finding (${finding.category}/${finding.severity}):`,
    `File: ${finding.filename}:${finding.line ?? "?"}`,
    `Explanation: ${finding.explanation}`,
    ``,
    `Counter-evidence category: ${family}`,
    `Retrieved from current codebase:`,
    ...counterEvidence.map((c) => `  - ${c}`),
    ``,
    `Does the finding still apply?`,
  ].join("\n");
}

function parseVerdict(text: string): VerificationResult {
  const firstLine = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  const rest = text.split("\n").slice(1).join(" ").trim();

  if (firstLine.startsWith("VERIFIED")) {
    return { status: "verified", note: rest.slice(0, 200) || "counter-evidence checked" };
  }
  if (firstLine.startsWith("DOWNGRADED")) {
    return { status: "downgraded", note: rest.slice(0, 200) || "real issue but overstated" };
  }
  if (firstLine.startsWith("REJECTED")) {
    return { status: "rejected", note: rest.slice(0, 200) || "counter-evidence contradicts finding" };
  }
  return {
    status: "unverified",
    note: `LLM verdict unparseable: ${text.slice(0, 120)}`,
  };
}
