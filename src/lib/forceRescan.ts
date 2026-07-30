/**
 * Force re-scan visibility — independent of fleeting local isScanning flags.
 * Operators need recovery after complete / null-rating / failed / stuck runs.
 */
export function canForceRescan(opts: {
  hasSelectedPr: boolean;
  /** Repo is reviewable when indexed (same gate as Run PR Review). */
  repoReviewable: boolean;
}): boolean {
  return opts.hasSelectedPr && opts.repoReviewable;
}
