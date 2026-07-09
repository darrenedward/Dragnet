/**
 * Provider outcome classifier for the review loop.
 *
 * Every LLM provider attempt ends in exactly one outcome:
 *
 *   - `success`           provider returned a valid structured review
 *   - `quality_failure`   provider ran but failed as a reviewer (loop
 *                         exhausted without submitReview, repeated
 *                         malformed tool calls, refusal, empty findings)
 *   - `transport_failure` retryable API/transport error (429, 5xx,
 *                         ECONNRESET, ETIMEDOUT, fetch failures)
 *   - `interrupted`       abort/interruption — checkpoint-resumable
 *   - `unknown_failure`   uncategorized failure, surfaced honestly
 *
 * **What quality_failure is NOT:** a low rating. A 4/10 review with
 * valid findings is a SUCCESSFUL scan — the model did its job, the PR
 * is just bad. If Phase 3's circuit breaker later needs to spot
 * suspicious low-quality outputs, that becomes a separate signal
 * (e.g. `low_confidence_success`), never quality_failure. This keeps
 * the breaker from punishing a model for correctly identifying a
 * broken PR.
 *
 * Used by `reviewService.ts` provider loop (per-provider catch and
 * post-loop). Phases 2 (telemetry), 3 (breaker), and 5 (resume)
 * consume the classified outcomes.
 *
 * The retryable-error check replicates `isRetryableProviderFailure()`
 * logic from `reviewService.ts:85` inline to avoid a circular import
 * (reviewService imports this module). Tests keep both in sync.
 */

export type OutcomeClass =
  | "success"
  | "quality_failure"
  | "transport_failure"
  | "interrupted"
  | "unknown_failure";

/**
 * Per-provider attempt record for cost telemetry. Lives here (rather than
 * in `reviewService.ts`) so one-shot LLM callers like `skepticRerate.ts`
 * can construct attempts without importing the 2300-line reviewService
 * (circular-dep risk). `reviewService.ts` re-exports this for back-compat.
 */
export interface ProviderAttempt {
  provider: string;
  model: string;
  iterationsUsed: number;
  maxIterations: number;
  submitReviewCalled: boolean;
  rating: number | null;
  error: unknown;
  outcome: OutcomeClass;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ClassifyInput {
  /** Thrown error or null when no exception occurred. */
  error: unknown;
  /** Whether submitReview was called (or JSON finalReview parsed). */
  submitReviewCalled: boolean;
  /** Final rating 1-10, or null when no review was produced. */
  rating: number | null;
  /** Iterations actually executed against the provider. */
  iterationsUsed: number;
  /** Per-preset iteration cap. */
  maxIterations: number;
  /** Consecutive malformed tool calls (JSON parse errors or invalid
   *  submitReview shape). Resets to 0 on any successful tool call. */
  malformedStreak: number;
  /** Explicit abort/interruption flag from caller (e.g. AbortSignal). */
  interrupted: boolean;
  /** Phase 3 signal: model returned refusal-style text. Phase 1
   *  wiring passes false. */
  refusalDetected: boolean;
  /** Phase 3 signal: submitReview called but findings array is empty
   *  with no evidence. Phase 1 wiring passes false. */
  emptyFindings: boolean;
}

/** Hard cap on consecutive malformed tool calls before bailing. */
export const MALFORMED_STREAK_THRESHOLD = 3;

/**
 * Returns true when an error looks like a retryable transport-layer
 * failure (HTTP 408/409/425/429/5xx, ECONN*, ETIMEDOUT, or a message
 * matching the network-error regex).
 *
 * Mirrors `isRetryableProviderFailure` in `reviewService.ts:85`. Kept
 * in sync via `tests/failureClassifier.test.ts`.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const status = Number(anyErr?.status ?? anyErr?.response?.status);
  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  const code = String(anyErr?.code ?? anyErr?.cause?.code ?? "");
  if (
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETDOWN",
      "ENETUNREACH",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
    ].includes(code)
  ) {
    return true;
  }

  const message = String(anyErr?.message ?? anyErr);
  return /\b(429|rate limit|timeout|timed out|aborted|connection (error|lost|closed|reset|refused)|network|socket|fetch failed)\b/i.test(
    message,
  );
}

/** Returns true when an error has the AbortError shape. */
function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as any)?.name ?? "";
  return name === "AbortError";
}

/**
 * Classify a provider attempt. Rules applied in priority order
 * (first match wins):
 *
 *   1. interrupted flag OR AbortError shape → `interrupted`
 *   2. error AND retryable                  → `transport_failure`
 *   3. error AND NOT retryable              → `unknown_failure`
 *   4. !submitReview, exhausted iterations  → `quality_failure`
 *   5. !submitReview, exited early          → `quality_failure`
 *   6. malformedStreak >= threshold         → `quality_failure`
 *   7. submitReview AND refusalDetected     → `quality_failure`
 *   8. submitReview AND emptyFindings       → `quality_failure`
 *   9. submitReview AND rating !== null     → `success`
 *  10. otherwise                            → `unknown_failure`
 *
 * Quality_failure is reserved for scan-mechanism failures, not low
 * ratings. See file-level docstring.
 */
export function classifyProviderOutcome(input: ClassifyInput): OutcomeClass {
  // Rule 1: explicit abort beats everything else.
  if (input.interrupted || isAbortError(input.error)) {
    return "interrupted";
  }

  // Rules 2-3: error path.
  if (input.error) {
    return isRetryableError(input.error) ? "transport_failure" : "unknown_failure";
  }

  // Rule 6: malformed streak fires regardless of submitReview state —
  // a model that can't form a valid tool call 3 times in a row has
  // failed as a reviewer even if it eventually squeezed through.
  if (input.malformedStreak >= MALFORMED_STREAK_THRESHOLD) {
    return "quality_failure";
  }

  // Rules 4-5: provider exited without producing a review.
  if (!input.submitReviewCalled) {
    return "quality_failure";
  }

  // Rules 7-8: reserved for Phase 3 signals.
  if (input.refusalDetected) {
    return "quality_failure";
  }
  if (input.emptyFindings) {
    return "quality_failure";
  }

  // Rule 9: caller decides what counts as success — submitReview was
  // called and a rating exists. Low rating is still success.
  if (input.rating !== null) {
    return "success";
  }

  // Rule 10.
  return "unknown_failure";
}
