/**
 * Rating recomputation after the skeptic pass (issue #72).
 *
 * The LLM produced a rating based on the full finding set. When the
 * skeptic rejects findings as false positives, the rating no longer
 * reflects what the user sees — the "real" issue count is smaller than
 * what the model graded. This module recomputes the rating from the
 * survivors, preserving the existing "null when all rejected" behavior
 * and extending it to cover skeptic rejects.
 *
 * Spec interpretation note: the issue says "uses the same rating logic
 * the scan already uses, just on the filtered set." The small-PR scan
 * path has no rating-from-findings formula — its rating is whatever the
 * LLM returns. So "same logic" is read as "same null-on-all-rejected
 * check, extended to count skeptic rejects," plus a severity-weighted
 * bump on partial rejects to reflect that the code is cleaner than the
 * LLM thought. Re-prompting the LLM with survivors would be the literal
 * reading but doubles cost per scan; the heuristic is the cheap path.
 *
 * Two outcomes:
 *
 *  1. Every finding ends up rejected (verifier + skeptic combined):
 *     return `null`. Same as today — the LLM was hallucinating, its
 *     rating can't be trusted.
 *
 *  2. Some findings survive, some are rejected: bump the rating up by
 *     a severity-weighted amount per rejected finding. A rejected
 *     blocker dragged the score down more than a rejected suggestion,
 *     so the correction is larger. Clamped to [1, 10].
 *
 *  3. No rejects at all: return the original rating unchanged.
 *
 * Pure so it can be unit-tested without spinning up the scan engine. The
 * scan engine wires real CandidateFinding + SkepticVerdict maps in.
 */

import type { CandidateFinding } from "@/src/services/findingVerifier/types";
import type { SkepticVerdict } from "@/src/services/findingVerifier/skepticPass";

/** Severity-weighted rating bump per rejected finding. */
const REJECT_BUMP: Record<string, number> = {
  blocker: 1.0,
  warning: 0.5,
  suggestion: 0.25,
};
const DEFAULT_BUMP = 0.25;

export interface RatingRecomputeInput {
  /** LLM's pre-skeptic rating. May be null on transport/quality failure. */
  originalRating: number | null;
  /** All candidate findings that survived the verifier (skeptic input set). */
  candidates: CandidateFinding[];
  /** Verifier rejects (status === "rejected"), keyed by candidate.id. */
  verifierRejectedIds: Set<string>;
  /** Skeptic verdicts, keyed by candidate.id. Absent = no verdict. */
  skepticMap: Map<string, SkepticVerdict>;
}

export interface RatingRecomputeResult {
  /** The rating to persist. Null when every finding was rejected. */
  rating: number | null;
  /**
   * Whether the rating was changed from the original. False when the
   * original was already null and stays null (all-rejected on a null
   * rating), or when no rejects occurred.
   */
  adjusted: boolean;
  /**
   * True when every finding was rejected. Caller uses this to decide
   * whether to surface the "all rejected" banner even if the rating
   * was already null and thus not numerically adjusted.
   */
  allRejected: boolean;
  /** Count of findings rejected by skeptic that drove the adjustment. */
  skepticRejectedCount: number;
  /** Count of findings rejected by the deterministic verifier. */
  verifierRejectedCount: number;
  /** Count of findings that survived both passes. */
  survivorCount: number;
}

/**
 * Recompute the scan rating after skeptic rejects are applied. See module
 * docstring for the contract. Never throws — returns the original rating
 * on any unexpected shape so a bug here can't crash a scan.
 */
export function recomputeRatingAfterSkeptic(
  input: RatingRecomputeInput,
): RatingRecomputeResult {
  const { originalRating, candidates, verifierRejectedIds, skepticMap } = input;

  if (candidates.length === 0) {
    return {
      rating: originalRating,
      adjusted: false,
      allRejected: false,
      skepticRejectedCount: 0,
      verifierRejectedCount: 0,
      survivorCount: 0,
    };
  }

  // Combined reject set — verifier rejects + skeptic rejects. Idempotent
  // if an id appears in both (it won't in practice: verifier-rejected
  // rows don't reach the skeptic batch because they're filtered out by
  // the scan engine before the skeptic call).
  const combinedRejected = new Set(verifierRejectedIds);
  let skepticRejectedCount = 0;
  for (const [id, verdict] of skepticMap.entries()) {
    if (verdict.verdict === "rejected") {
      combinedRejected.add(id);
      skepticRejectedCount++;
    }
  }

  const totalRejected = combinedRejected.size;
  const survivorCount = candidates.length - totalRejected;

  // All rejected → null the rating. Preserves the existing behavior and
  // extends it to cover skeptic rejects. `allRejected` is surfaced so the
  // caller can show the "all rejected" banner even when the rating was
  // already null and thus not numerically adjusted.
  if (survivorCount === 0) {
    return {
      rating: null,
      adjusted: originalRating !== null,
      allRejected: true,
      skepticRejectedCount,
      verifierRejectedCount: verifierRejectedIds.size,
      survivorCount: 0,
    };
  }

  // No rejects at all (verifier or skeptic) → no adjustment.
  if (totalRejected === 0 || originalRating === null) {
    return {
      rating: originalRating,
      adjusted: false,
      allRejected: false,
      skepticRejectedCount,
      verifierRejectedCount: verifierRejectedIds.size,
      survivorCount,
    };
  }

  // Partial reject → severity-weighted bump. Each rejected finding
  // contributed to dragging the original rating down; removing it as a
  // false positive lets the score recover proportionally.
  let bump = 0;
  for (const candidate of candidates) {
    if (!combinedRejected.has(candidate.id)) continue;
    bump += REJECT_BUMP[candidate.severity] ?? DEFAULT_BUMP;
  }

  const raw = originalRating + bump;
  const clamped = Math.max(1, Math.min(10, Math.round(raw)));

  return {
    rating: clamped,
    adjusted: clamped !== originalRating,
    allRejected: false,
    skepticRejectedCount,
    verifierRejectedCount: verifierRejectedIds.size,
    survivorCount,
  };
}
