/**
 * Shared merge-readiness contract.
 *
 * "Scan finished" (ReviewRun.status === "completed") is not the same as
 * merge-ready. Prepush, findings API, `/dragnet merge`, and the PR header
 * all use this helper so CLI and UI never disagree.
 *
 * mergeReady =
 *   run finished successfully
 *   AND outcome is not skipped
 *   AND rating is non-null and >= 8
 *   AND reliability is absent-or-complete (incomplete/partial = not ready)
 *   AND not refused
 *   AND not stale vs current tip (commit identity) / revision when known
 */

import {
  reviewStaleLabel,
  type ReviewStaleReason,
} from "./reviewStale";

export const MERGE_RATING_THRESHOLD = 8;

export type MergeBlockReason =
  | "no_run"
  | "not_finished"
  | "skipped"
  | "null_rating"
  | "rating_below_threshold"
  | "reliability_incomplete"
  | "coverage_incomplete"
  | "refused"
  | "stale";

export interface MergeReadyInput {
  /** Lifecycle status of the review run. */
  status?: string | null;
  /** User-facing terminal classification: "reviewed" | "skipped" | null. */
  outcome?: string | null;
  rating?: number | null;
  /** "complete" | "partial" | "incomplete_security_review" | null/undefined. */
  reliability?: string | null;
  refused?: boolean | null;
  /**
   * When known, true means the completed run does not match current tip
   * and/or diff. Tip identity is part of the merge gate — a high score on
   * an old tip must not pass.
   */
  stale?: boolean | null;
  /** Optional detail when stale — tip moved vs diff changed. */
  staleReason?: ReviewStaleReason | null;
  /** Optional persisted chunk coverage; terminal coverage is required when present. */
  chunksTotal?: number | null;
  chunksCompleted?: number | null;
  chunksFailed?: number | null;
  chunksSkipped?: number | null;
}

export interface MergeReadyResult {
  mergeReady: boolean;
  mergeBlockReason: MergeBlockReason | null;
  /** Human-readable reason suitable for UI / CLI. */
  message: string | null;
}

/**
 * Evaluate whether a finished review is merge-ready under the shared rule.
 * When `status` is omitted (legacy callers that only have a rating), treat
 * the run as finished so prepush/findings of completed runs still work.
 */
export function isMergeReady(input: MergeReadyInput | null | undefined): MergeReadyResult {
  if (!input) {
    return {
      mergeReady: false,
      mergeBlockReason: "no_run",
      message: "No completed review yet.",
    };
  }

  if (input.status != null && input.status !== "completed") {
    return {
      mergeReady: false,
      mergeBlockReason: "not_finished",
      message: `Scan not finished (status: ${input.status}).`,
    };
  }

  if (input.outcome === "skipped") {
    return {
      mergeReady: false,
      mergeBlockReason: "skipped",
      message: "Review was skipped (trivial/empty diff) — not merge-ready.",
    };
  }

  if (input.rating === null || input.rating === undefined) {
    return {
      mergeReady: false,
      mergeBlockReason: "null_rating",
      message: "Rating unavailable — not merge-ready.",
    };
  }

  if (
    input.chunksTotal != null &&
    input.chunksCompleted != null &&
    input.chunksFailed != null &&
    input.chunksSkipped != null &&
    input.chunksCompleted + input.chunksFailed + input.chunksSkipped < input.chunksTotal
  ) {
    return {
      mergeReady: false,
      mergeBlockReason: "coverage_incomplete",
      message: `Review coverage is incomplete (${input.chunksCompleted + input.chunksFailed + input.chunksSkipped}/${input.chunksTotal} chunks terminal).`,
    };
  }

  if (input.rating < MERGE_RATING_THRESHOLD) {
    return {
      mergeReady: false,
      mergeBlockReason: "rating_below_threshold",
      message: `Rating ${input.rating}/10 is below the merge threshold (${MERGE_RATING_THRESHOLD}+).`,
    };
  }

  if (
    input.reliability != null &&
    input.reliability !== "" &&
    input.reliability !== "complete"
  ) {
    return {
      mergeReady: false,
      mergeBlockReason: "reliability_incomplete",
      message: `Reliability is ${input.reliability} — not merge-ready until coverage is complete.`,
    };
  }

  if (input.refused === true) {
    return {
      mergeReady: false,
      mergeBlockReason: "refused",
      message: "Reviewer flagged incomplete coverage — not merge-ready.",
    };
  }

  if (input.stale === true) {
    return {
      mergeReady: false,
      mergeBlockReason: "stale",
      message: reviewStaleLabel(input.staleReason),
    };
  }

  return { mergeReady: true, mergeBlockReason: null, message: null };
}

/** Short UI label: Merge ready | Not ready (reason) | Blocked at {gate}. */
export function mergeReadyLabel(result: MergeReadyResult, blockedGate?: string | null): string {
  if (blockedGate) return `Blocked at ${blockedGate}`;
  if (result.mergeReady) return "Merge ready";
  if (result.mergeBlockReason === "no_run" || result.mergeBlockReason === "not_finished") {
    return result.message ?? "Not ready";
  }
  return result.message ? `Not ready (${result.message})` : "Not ready";
}
