/**
 * Post-aggregate findings publish pipeline.
 *
 * Fixed order before findings are exposed as the run result:
 *   1. Fingerprint intra-run dedupe
 *   2. Conservative root-cause cluster (optional later — ticket #150)
 *   3. Re-verify survivors when cluster changed evidence/locations (#150)
 *   4. Cross-run reconcile
 *   5. Load published set (non-rejected verifier/skeptic)
 *
 * Large-PR aggregate and single-shot completion both call this seam so
 * published findings are fingerprint-clean. Clustering is reserved; this
 * ticket implements fingerprint parity only (skipCluster defaults true).
 */

import { prisma } from "@/src/lib/prisma";
import { dedupFindingsWithinRun, reconcileFindingsAcrossRuns } from "./reconcile";

export const PUBLISH_ORDER = [
  "fingerprint_dedupe",
  "root_cause_cluster",
  "reverify_survivors",
  "cross_run_reconcile",
  "load_published",
] as const;

export type PublishStep = (typeof PUBLISH_ORDER)[number];

export interface PublishFindingsResult {
  findings: Awaited<ReturnType<typeof loadPublishedFindings>>;
  steps: {
    fingerprintDupesRemoved: number;
    clustersMerged: number;
    clusterMembersRemoved: number;
    reverified: number;
  };
  order: readonly PublishStep[];
}

export interface PublishFindingsOptions {
  /**
   * Skip cluster + re-verify (fingerprint + reconcile only).
   * Defaults true until root-cause clustering lands (#150).
   */
  skipCluster?: boolean;
  /** Repo filesystem path for re-verify. When absent, re-verify is skipped. */
  repoPath?: string | null;
  prId?: string;
}

/**
 * Pure helper: drop planned duplicate ids from a finding list.
 * Mirrors publish step 1 survivor selection for unit tests without DB.
 */
export function selectPublishedSurvivors<T extends { id: string }>(
  findings: T[],
  duplicateIds: string[],
): T[] {
  if (duplicateIds.length === 0) return findings;
  const drop = new Set(duplicateIds);
  return findings.filter((f) => !drop.has(f.id));
}

async function loadPublishedFindings(reviewRunId: string) {
  return prisma.reviewFinding.findMany({
    where: {
      reviewRunId,
      OR: [
        { verificationStatus: null },
        { verificationStatus: { not: "rejected" } },
      ],
      AND: [
        {
          OR: [
            { skepticVerdict: null },
            { skepticVerdict: { not: "rejected" } },
          ],
        },
      ],
    },
    orderBy: [{ filename: "asc" }, { line: "asc" }],
  });
}

/**
 * Run the post-aggregate publish pipeline for a review run.
 *
 * Order is fixed and testable via PUBLISH_ORDER. Cluster + re-verify steps
 * are no-ops while skipCluster is true (default).
 */
export async function publishFindingsForRun(
  reviewRunId: string,
  options: PublishFindingsOptions = {},
): Promise<PublishFindingsResult> {
  const skipCluster = options.skipCluster !== false;

  let fingerprintDupesRemoved = 0;
  const clustersMerged = 0;
  const clusterMembersRemoved = 0;
  const reverified = 0;

  // 1. Fingerprint intra-run dedupe
  try {
    fingerprintDupesRemoved = await dedupFindingsWithinRun(reviewRunId);
  } catch (err) {
    console.error(`[publish] fingerprint dedupe failed for run ${reviewRunId}:`, err);
  }

  // 2–3. Root-cause cluster + re-verify survivors (reserved for #150)
  if (!skipCluster) {
    console.warn(
      `[publish] root-cause cluster requested for run ${reviewRunId} but clustering is not enabled yet; skipping`,
    );
  }

  // 4. Cross-run reconcile
  try {
    const run = await prisma.reviewRun.findUnique({
      where: { id: reviewRunId },
      select: { prId: true },
    });
    if (run) {
      await reconcileFindingsAcrossRuns(run.prId, reviewRunId);
    }
  } catch (err) {
    console.error(`[publish] reconcile failed for run ${reviewRunId}:`, err);
  }

  // 5. Load published set
  let findings: Awaited<ReturnType<typeof loadPublishedFindings>> = [];
  try {
    findings = await loadPublishedFindings(reviewRunId);
  } catch (err) {
    console.error(`[publish] load published findings failed for run ${reviewRunId}:`, err);
  }

  return {
    findings,
    steps: {
      fingerprintDupesRemoved,
      clustersMerged,
      clusterMembersRemoved,
      reverified,
    },
    order: PUBLISH_ORDER,
  };
}
