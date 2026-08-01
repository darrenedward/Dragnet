/**
 * Agentic-loop finish reliability helpers (issue #138).
 *
 * Prevent tool-only thrash from burning the whole maxIterations budget
 * without submitReview: reserve final iteration(s) for a forced finish
 * path, and format end-of-attempt forensic logs.
 */

/** Last N main-loop iterations force submitReview when no review yet. */
export const FINISH_RESERVE_ITERATIONS = 1;

export const SUBMIT_REVIEW_TOOL_CHOICE = {
  type: "function" as const,
  function: { name: "submitReview" },
};

/**
 * True when this main-loop iteration should force the finish path:
 * no usable review yet and we are inside the reserved tail of the budget.
 *
 * `loopCount` is 1-based after the loop increments (iteration 1..budget).
 */
export function shouldForceSubmitPath(
  loopCount: number,
  iterationBudget: number,
  hasSubmitReview: boolean,
  reserve: number = FINISH_RESERVE_ITERATIONS,
): boolean {
  if (hasSubmitReview) return false;
  if (!Number.isFinite(loopCount) || !Number.isFinite(iterationBudget)) return false;
  if (iterationBudget < 1 || loopCount < 1) return false;
  const safeReserve = Math.max(1, Math.floor(reserve));
  return loopCount > iterationBudget - safeReserve;
}

export function finishPathNudgeMessage(): string {
  return (
    "Iteration budget nearly exhausted and you have not called submitReview yet. " +
    "Call submitReview NOW with your final rating, summary, and findings array. " +
    "Do not call any other tools."
  );
}

export function finishPathToolChoice(): typeof SUBMIT_REVIEW_TOOL_CHOICE {
  return SUBMIT_REVIEW_TOOL_CHOICE;
}

export interface AttemptEndLogFields {
  provider: string;
  outcome: string;
  iterationsUsed: number;
  maxIterations: number;
  submitReview: boolean;
  malformedCount: number;
  finalizerAttempted: boolean;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  errorMessage?: string | null;
}

/** Single-line console forensic for one provider attempt. */
export function formatAttemptEndConsoleLog(f: AttemptEndLogFields): string {
  const tokens =
    f.promptTokens !== undefined && f.completionTokens !== undefined
      ? ` tokens=${f.promptTokens}+${f.completionTokens}`
      : "";
  const cost =
    f.costUsd !== undefined ? ` cost=$${f.costUsd.toFixed(6)}` : "";
  const err = f.errorMessage ? ` error=${f.errorMessage}` : "";
  return (
    `[review] provider ${f.provider} outcome=${f.outcome} ` +
    `iterations=${f.iterationsUsed}/${f.maxIterations} ` +
    `submitReview=${f.submitReview} malformed=${f.malformedCount} ` +
    `finalizerAttempted=${f.finalizerAttempted}` +
    tokens +
    cost +
    err
  );
}

/** In-app scan log line for the same attempt end. */
export function formatAttemptEndReviewLog(f: AttemptEndLogFields): string {
  return (
    `Attempt end: provider=${f.provider} outcome=${f.outcome} ` +
    `iterations=${f.iterationsUsed}/${f.maxIterations} ` +
    `submitReview=${f.submitReview} malformed=${f.malformedCount} ` +
    `finalizerAttempted=${f.finalizerAttempted}`
  );
}
