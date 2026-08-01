/**
 * Review staleness vs the PR tip and current diff.
 *
 * A completed run is stale when:
 * - its commitHash no longer matches the PR tip (tip moved), or
 * - its diffHash no longer matches the current PrFile diff.
 *
 * Tip mismatch wins when both disagree — operators should re-scan at tip.
 * Empty hashes are fail-open (unknown → not stale) so missing identity
 * never false-blocks merge without a known mismatch.
 */

export type ReviewStaleReason = "tip_mismatch" | "diff_changed";

export interface ReviewStaleInput {
  runCommitHash?: string | null;
  tipCommitHash?: string | null;
  runDiffHash?: string | null;
  currentDiffHash?: string | null;
}

export interface ReviewStaleResult {
  stale: boolean;
  reason: ReviewStaleReason | null;
}

export function evaluateReviewStale(input: ReviewStaleInput): ReviewStaleResult {
  const runTip = (input.runCommitHash ?? "").trim();
  const tip = (input.tipCommitHash ?? "").trim();
  if (runTip && tip && runTip !== tip) {
    return { stale: true, reason: "tip_mismatch" };
  }

  const runDiff = (input.runDiffHash ?? "").trim();
  const currentDiff = (input.currentDiffHash ?? "").trim();
  if (runDiff && runDiff !== currentDiff) {
    return { stale: true, reason: "diff_changed" };
  }

  return { stale: false, reason: null };
}

/** Human label for chip/banner tooltips. */
export function reviewStaleLabel(reason: ReviewStaleReason | null | undefined): string {
  if (reason === "tip_mismatch") {
    return "Tip moved — completed review does not match current PR tip. Re-scan required.";
  }
  if (reason === "diff_changed") {
    return "Review is stale vs current diff — re-scan required.";
  }
  return "Review is stale vs current tip — re-scan required.";
}
