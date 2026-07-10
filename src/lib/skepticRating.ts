/**
 * Reject summary for the skeptic pass (issue #72).
 *
 * The scan engine calls this after both the deterministic verifier and
 * the skeptic pass have run, to get a single picture of what was rejected
 * and what survived. The rating decision itself moved to `reviewService.ts`
 * because re-evaluation is now async (an LLM re-prompt via
 * `skepticRerate.ts`). This module is pure and synchronous — it just
 * combines the two reject sources and counts.
 *
 * Contract:
 *  - `allRejected` → caller nulls the rating (LLM was hallucinating).
 *  - `anyRejected && !allRejected` → caller triggers the LLM re-prompt
 *    with the survivors.
 *  - `!anyRejected` → caller leaves the rating unchanged.
 *
 * Pure so it can be unit-tested without spinning up the scan engine.
 */

import type { CandidateFinding } from "@/src/services/findingVerifier/types";
import type { SkepticVerdict } from "@/src/services/findingVerifier/skepticPass";

export interface RejectSummaryInput {
  /** All candidate findings that survived the verifier (skeptic input set). */
  candidates: CandidateFinding[];
  /** Verifier rejects (status === "rejected"), keyed by candidate.id. */
  verifierRejectedIds: Set<string>;
  /** Skeptic verdicts, keyed by candidate.id. Absent = no verdict. */
  skepticMap: Map<string, SkepticVerdict>;
}

export interface RejectSummary {
  /** Total findings rejected by either pass. */
  totalRejected: number;
  /** Findings rejected by the skeptic pass specifically. */
  skepticRejectedCount: number;
  /** Findings rejected by the deterministic verifier. */
  verifierRejectedCount: number;
  /** Findings that survived both passes. */
  survivorCount: number;
  /** True when every candidate was rejected — caller nulls the rating. */
  allRejected: boolean;
  /** True when at least one candidate was rejected — caller re-prompts. */
  anyRejected: boolean;
  /** Combined id set (verifier ∪ skeptic rejects) for survivor filtering. */
  combinedRejectedIds: Set<string>;
}

/**
 * Combine verifier + skeptic rejects into one summary. Never throws.
 */
export function summarizeRejects(input: RejectSummaryInput): RejectSummary {
  const { candidates, verifierRejectedIds, skepticMap } = input;

  if (candidates.length === 0) {
    return {
      totalRejected: 0,
      skepticRejectedCount: 0,
      verifierRejectedCount: 0,
      survivorCount: 0,
      allRejected: false,
      anyRejected: false,
      combinedRejectedIds: new Set(),
    };
  }

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

  return {
    totalRejected,
    skepticRejectedCount,
    verifierRejectedCount: verifierRejectedIds.size,
    survivorCount,
    allRejected: survivorCount === 0,
    anyRejected: totalRejected > 0,
    combinedRejectedIds: combinedRejected,
  };
}
