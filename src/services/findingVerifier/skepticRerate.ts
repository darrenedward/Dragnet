/**
 * Skeptic re-rate — ask the primary chat model to re-grade the PR after
 * the skeptic pass rejects findings as false positives (issue #72).
 *
 * The original rating came from the LLM's `submitReview` call based on
 * the full finding set. When the skeptic rejects some of those findings,
 * the score no longer reflects what the user sees. Rather than apply an
 * uncalibrated heuristic bump, we send the survivors back to the primary
 * model for a fresh holistic grade. This is the literal reading of the
 * #72 spec ("uses the same rating logic the scan already uses, just on
 * the filtered set") — the scan's rating logic IS asking the LLM.
 *
 * Contract:
 *  - Iterates the chat chain primary-first, fallback-second. Returns on
 *    the first provider that produces a parseable `{rating, summary}`.
 *  - Never throws. On full chain failure or parse error, returns
 *    `{ok: false, error}` and the caller leaves the original rating in
 *    place with an honest systemWarn.
 *  - Records a `ProviderAttempt` per try so the caller can fold the
 *    re-rate's tokens into the run's cost telemetry.
 *  - Honors the per-repo circuit breaker via `getChatChain({repoPath})`
 *    so an open provider isn't wasted.
 *  - Re-summarizes in the same call — the original summary may reference
 *    rejected findings, which would mislead the user.
 */

import type { CandidateFinding } from "./types";
import { getChatChain, type ChainEntry } from "@/src/lib/llmClient";
import { reasoningOptions, supportsJsonResponseFormat } from "@/src/lib/llmResponseFormat";
import { computeCost } from "@/src/lib/llmPricing";
import type { ProviderAttempt, OutcomeClass } from "@/src/lib/failureClassifier";

/** Findings the skeptic rejected, with the reason given. */
export interface RejectedForRerate {
  id: string;
  category: string;
  severity: string;
  reason: string;
}

export interface RerateInput {
  /** Findings that survived both verifier and skeptic. */
  survivors: CandidateFinding[];
  /** Findings the skeptic rejected, with their skeptic note as the reason. */
  rejected: RejectedForRerate[];
  /** The LLM's pre-skeptic rating, shown to the model for context. */
  originalRating: number;
  /** The LLM's pre-skeptic summary, shown for context (not reused). */
  originalSummary: string;
  /** Repo path for breaker-aware chain resolution. null for remote-volume repos. */
  repoPath: string | null;
}

export interface RerateResult {
  /** The fresh rating from the re-prompt. Null when ok=false. */
  rating: number | null;
  /** Fresh summary covering only the survivors. Empty string when ok=false. */
  summary: string;
  /** True when at least one provider returned a parseable response. */
  ok: boolean;
  /** Failure reason when ok=false. */
  error?: string;
  /** Per-provider attempts for token/cost telemetry. */
  attempts: ProviderAttempt[];
}

const RERATE_MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a code reviewer re-evaluating a pull request after adversarial review.

You previously rated this PR. Some of your original findings were just rejected as false positives by an adversarial second-opinion model. Re-grade the PR based ONLY on the surviving findings — do not reference the rejected ones in your summary.

Rules:
- Rating is 1-10, where 8+ is production-grade.
- A 10/10 on genuinely clean code is correct, not a failure.
- The survivor list is the ground truth for what issues remain.

Respond with JSON only, no markdown fences:
{"rating": <integer 1-10>, "summary": "<2-4 sentences covering only the surviving findings>"}`;

/**
 * Run the re-rate across the chat chain. See module docstring.
 */
export async function rerateWithSurvivors(input: RerateInput): Promise<RerateResult> {
  const { survivors, rejected, originalRating, originalSummary, repoPath } = input;

  if (survivors.length === 0) {
    return {
      rating: null,
      summary: "",
      ok: false,
      error: "no survivors to re-rate",
      attempts: [],
    };
  }

  const chain: ChainEntry[] = getChatChain({ repoPath });
  if (chain.length === 0) {
    return {
      rating: null,
      summary: "",
      ok: false,
      error: "no chat provider configured",
      attempts: [],
    };
  }

  const userPrompt = buildUserPrompt(survivors, rejected, originalRating, originalSummary);
  const attempts: ProviderAttempt[] = [];

  for (const entry of chain) {
    const attempt = await tryRerate(entry, userPrompt);
    attempts.push(attempt);
    if (attempt.outcome === "success" && attempt.rating !== null) {
      return {
        rating: attempt.rating,
        summary: attempt.summary ?? "",
        ok: true,
        attempts,
      };
    }
  }

  const lastError = attempts[attempts.length - 1]?.error;
  const errorReason =
    typeof lastError === "string"
      ? lastError
      : lastError instanceof Error
        ? lastError.message
        : "all providers failed";
  return {
    rating: null,
    summary: "",
    ok: false,
    error: errorReason,
    attempts,
  };
}

interface RerateAttempt extends ProviderAttempt {
  /** Parsed summary on success; undefined otherwise. */
  summary?: string;
}

async function tryRerate(entry: ChainEntry, userPrompt: string): Promise<RerateAttempt> {
  let outcome: OutcomeClass = "transport_failure";
  let rating: number | null = null;
  let summary: string | undefined;
  let error: unknown = null;
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const params: Record<string, unknown> = {
      model: entry.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      ...reasoningOptions(entry.model, RERATE_MAX_TOKENS),
    };
    if (supportsJsonResponseFormat(entry.endpoint)) {
      params.response_format = { type: "json_object" };
    }

    const response: any = await entry.client.chat.completions.create(params as any);
    if (response?.usage) {
      promptTokens = response.usage.prompt_tokens ?? 0;
      completionTokens = response.usage.completion_tokens ?? 0;
    }

    const raw = response?.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = parseRerateResponse(raw);
    if (parsed) {
      rating = parsed.rating;
      summary = parsed.summary;
      outcome = "success";
    } else {
      outcome = "quality_failure";
      error = new Error(`unparseable re-rate response: ${raw.slice(0, 120)}`);
    }
  } catch (err) {
    error = err;
    outcome = "transport_failure";
  }

  const { costUsd } = computeCost(entry.model, promptTokens, completionTokens);

  return {
    provider: entry.name,
    model: entry.model,
    // Shape-only values for the ProviderAttempt contract (designed for the
    // agentic scan loop). Re-rate is one-shot: 1 iteration, no submitReview
    // tool call. submitReviewCalled is faked to match outcome semantics so
    // downstream breaker logic treats a parse failure as quality_failure.
    iterationsUsed: 1,
    maxIterations: entry.maxIterations,
    submitReviewCalled: outcome === "success",
    rating,
    error,
    outcome,
    promptTokens,
    completionTokens,
    costUsd,
    summary,
  };
}

interface ParsedRerate {
  rating: number;
  summary: string;
}

function parseRerateResponse(raw: string): ParsedRerate | null {
  if (!raw) return null;
  const cleaned = stripThinkBlocks(raw).trim();
  if (!cleaned) return null;

  const candidates: string[] = [];
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());
  candidates.push(cleaned);
  const jsonObjectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch && jsonObjectMatch[0] !== cleaned) {
    candidates.push(jsonObjectMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        const rating = coerceRating(parsed.rating);
        const summary =
          typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "";
        if (rating !== null) return { rating, summary };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function coerceRating(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(10, Math.round(value)));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return Math.max(1, Math.min(10, Math.round(parsed)));
  }
  return null;
}

function buildUserPrompt(
  survivors: CandidateFinding[],
  rejected: RejectedForRerate[],
  originalRating: number,
  originalSummary: string,
): string {
  const rejectedBlock =
    rejected.length === 0
      ? "(none)"
      : rejected
          .map(
            (r, i) =>
              `[${i + 1}] category=${r.category} severity=${r.severity} — ${r.reason || "false positive"}`,
          )
          .join("\n");

  const survivorBlock = survivors
          .map(
            (f, i) =>
              `[${i + 1}] severity=${f.severity} | category=${f.category} | file=${f.filename}:${f.line ?? "?"}\n    ${f.explanation}`,
          )
          .join("\n");

  return [
    `Original rating: ${originalRating}/10`,
    `Original summary: ${originalSummary || "(none)"}`,
    "",
    "Rejected findings (DO NOT reference these in your summary):",
    rejectedBlock,
    "",
    `Surviving findings (${survivors.length}) — re-rate based ONLY on these:`,
    survivorBlock,
    "",
    `Respond with JSON: {"rating": <1-10>, "summary": "<2-4 sentences>"}`,
  ].join("\n");
}

function stripThinkBlocks(s: string): string {
  return s
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think[^>]*>[\s\S]*$/gi, "");
}
