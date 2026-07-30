/**
 * Shared merge-ready gate used by prepush, findings/status payloads, and
 * command PASS/FAIL text. "Scan finished" (Completed) is not the same as
 * merge-ready — rating, outcome, reliability, refusal, and freshness all
 * must pass.
 *
 * Rule (fail-closed):
 *   mergeReady =
 *     run finished successfully (when status is known)
 *     AND outcome is not skipped
 *     AND rating is non-null and >= MERGE_READY_RATING_THRESHOLD
 *     AND reliability is absent-or-complete
 *     AND not refused
 *     AND not stale (when staleness is known)
 */

export const MERGE_READY_RATING_THRESHOLD = 8;

export type MergeReadyInput = {
  /** 1–10 production rating; null/undefined = not merge-ready. */
  rating?: number | null;
  /** "reviewed" | "skipped" | null (legacy / failed / in-progress). */
  outcome?: string | null;
  /** "complete" | "partial" | "incomplete_security_review" | null (absent = ok). */
  reliability?: string | null;
  /** Reviewer flagged incomplete coverage. */
  refused?: boolean | null;
  /** Diff moved since the completed run (omit when unknown). */
  stale?: boolean | null;
  /** Lifecycle status when known: "completed" | "failed" | "in_progress" | … */
  status?: string | null;
};

export type MergeReadyResult = {
  mergeReady: boolean;
  /** Null when mergeReady; otherwise a short operator-facing reason. */
  mergeBlockReason: string | null;
};

/**
 * Evaluate whether a review run (or PR snapshot of one) is merge-ready.
 * Pure function — no I/O. Callers map their own shapes into MergeReadyInput.
 */
export function isMergeReady(input: MergeReadyInput): MergeReadyResult {
  const {
    rating = null,
    outcome = null,
    reliability = null,
    refused = false,
    stale = null,
    status = null,
  } = input;

  if (status != null && status !== "completed") {
    if (status === "failed") {
      return { mergeReady: false, mergeBlockReason: "Scan failed" };
    }
    if (status === "in_progress") {
      return { mergeReady: false, mergeBlockReason: "Scan still running" };
    }
    return { mergeReady: false, mergeBlockReason: `Scan not finished (${status})` };
  }

  if (outcome === "skipped") {
    return { mergeReady: false, mergeBlockReason: "Review skipped (no substantive code changes)" };
  }

  if (refused === true) {
    return { mergeReady: false, mergeBlockReason: "Reviewer refused incomplete coverage" };
  }

  if (rating == null || !Number.isFinite(rating)) {
    return { mergeReady: false, mergeBlockReason: "No rating (scan finished without a score)" };
  }

  if (rating < MERGE_READY_RATING_THRESHOLD) {
    return {
      mergeReady: false,
      mergeBlockReason: `Rating ${rating}/10 (requires ${MERGE_READY_RATING_THRESHOLD}+)`,
    };
  }

  if (reliability != null && reliability !== "complete") {
    return {
      mergeReady: false,
      mergeBlockReason: reliabilityLabel(reliability),
    };
  }

  if (stale === true) {
    return { mergeReady: false, mergeBlockReason: "Review out of date vs current diff" };
  }

  return { mergeReady: true, mergeBlockReason: null };
}

function reliabilityLabel(reliability: string): string {
  if (reliability === "partial") return "Reliability partial (incomplete coverage)";
  if (reliability === "incomplete_security_review") {
    return "Incomplete security review";
  }
  return `Reliability not complete (${reliability})`;
}

/** Convenience: boolean-only form for call sites that already surface a reason elsewhere. */
export function checkMergeReady(input: MergeReadyInput): boolean {
  return isMergeReady(input).mergeReady;
}
