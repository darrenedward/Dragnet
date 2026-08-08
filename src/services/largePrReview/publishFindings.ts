/**
 * Post-aggregate findings publish pipeline.
 *
 * Fixed order before findings are exposed as the run result:
 *   1. Fingerprint intra-run dedupe
 *   2. Conservative root-cause cluster (multi-location merge)
 *   3. Re-verify survivors when cluster changed evidence/locations
 *   4. Cross-run reconcile
 *   5. Load published set (non-rejected verifier/skeptic)
 *
 * Large-PR aggregate and single-shot completion both call this seam so
 * published findings are fingerprint-clean and optionally clustered.
 * Clustering is conservative (high-confidence same root only) — safe for
 * single-shot: no merge when unsure, never silent-drop.
 */

import { prisma } from "@/src/lib/prisma";
import { verifyFindings, type CandidateFinding } from "@/src/services/findingVerifier";
import {
  clusterDuplicateIds,
  planRootCauseClusters,
  type ClusterFinding,
} from "./cluster";
import { dedupFindingsWithinRun, reconcileFindingsAcrossRuns } from "./reconcile";
import { persistReviewArtifact } from "@/src/services/durableScanState";

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
   * Defaults false — root-cause clustering is on for large-PR and single-shot.
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

export interface ApplyRootCauseClustersOptions {
  /**
   * When true, clear verificationStatus/Note on survivors so step 3 can
   * re-stamp them. Only pass true when re-verify will actually run
   * (repoPath + prId available) — otherwise prior structural marks stay.
   * Skeptic fields are never cleared here: publish has no LLM skeptic chain.
   */
  clearVerificationForReverify?: boolean;
}

/**
 * Apply conservative root-cause clusters: update survivor evidence/locations
 * and delete sibling rows. Returns how many groups merged and members removed.
 */
export async function applyRootCauseClusters(
  reviewRunId: string,
  options: ApplyRootCauseClustersOptions = {},
): Promise<{
  clustersMerged: number;
  membersRemoved: number;
  reverifyIds: string[];
}> {
  // Match published-set filters: never cluster verifier/skeptic rejects.
  // A high-confidence skeptic reject winning the rank would delete good
  // siblings, then drop out of loadPublishedFindings — silent loss.
  const rows = await prisma.reviewFinding.findMany({
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
    select: {
      id: true,
      fingerprint: true,
      category: true,
      severity: true,
      filename: true,
      line: true,
      explanation: true,
      confidence: true,
      evidenceChain: true,
    },
  });

  const candidates: ClusterFinding[] = rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint ?? `id:${r.id}`,
    category: r.category,
    severity: r.severity,
    filename: r.filename,
    line: r.line,
    explanation: r.explanation,
    confidence: r.confidence,
    evidenceChain: r.evidenceChain,
  }));

  const groups = planRootCauseClusters(candidates);
  if (groups.length === 0) {
    return { clustersMerged: 0, membersRemoved: 0, reverifyIds: [] };
  }

  const reverifyIds: string[] = [];
  const duplicateIds = clusterDuplicateIds(groups);
  const clearVerification = options.clearVerificationForReverify === true;

  await prisma.$transaction(async (tx) => {
    for (const group of groups) {
      const keep = rows.find((r) => r.id === group.keepId);
      if (!keep) continue;

      const siblingNote = group.multiLocation
        .filter((loc) => !(loc.file === keep.filename && loc.line === keep.line))
        .map((loc) => `${loc.file}${loc.line != null ? `:${loc.line}` : ""}`)
        .join(", ");
      const explanation =
        !siblingNote || keep.explanation.includes("Also at:")
          ? keep.explanation
          : `${keep.explanation.trim()} Also at: ${siblingNote}`.slice(0, 4000);

      await tx.reviewFinding.update({
        where: { id: group.keepId },
        data: {
          explanation,
          severity: group.mergedSeverity,
          evidenceChain: JSON.stringify(group.mergedEvidenceChain),
          ...(clearVerification
            ? { verificationStatus: null, verificationNote: null }
            : {}),
        },
      });

      if (group.shouldReverify) reverifyIds.push(group.keepId);
    }

    if (duplicateIds.length > 0) {
      await tx.reviewFinding.deleteMany({ where: { id: { in: duplicateIds } } });
    }
  });

  return {
    clustersMerged: groups.length,
    membersRemoved: duplicateIds.length,
    reverifyIds,
  };
}

/**
 * Re-run the structural verifier on cluster survivors whose evidence/locations
 * changed. Structural verify is the deterministic re-check available without
 * an LLM skeptic chain at publish time (skeptic marks on the keep row are kept).
 */
export async function reverifySurvivors(
  findingIds: string[],
  repoPath: string,
  prId: string,
): Promise<number> {
  if (findingIds.length === 0) return 0;

  const rows = await prisma.reviewFinding.findMany({
    where: { id: { in: findingIds } },
    select: {
      id: true,
      category: true,
      severity: true,
      filename: true,
      line: true,
      explanation: true,
      source: true,
      confidence: true,
    },
  });
  if (rows.length === 0) return 0;

  const candidates: CandidateFinding[] = rows.map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    filename: r.filename,
    line: r.line,
    explanation: r.explanation,
    source: (r.source as CandidateFinding["source"]) ?? "llm",
    confidence: r.confidence,
  }));

  const results = await verifyFindings(candidates, repoPath, prId);
  let updated = 0;
  for (const row of rows) {
    const v = results.get(row.id);
    if (!v) continue;
    await prisma.reviewFinding.update({
      where: { id: row.id },
      data: {
        verificationStatus: v.status,
        verificationNote: v.note ?? null,
      },
    });
    updated += 1;
  }
  return updated;
}

/**
 * Run the post-aggregate publish pipeline for a review run.
 *
 * Order is fixed and testable via PUBLISH_ORDER. Cluster + re-verify run
 * unless skipCluster is true.
 */
export async function publishFindingsForRun(
  reviewRunId: string,
  options: PublishFindingsOptions = {},
): Promise<PublishFindingsResult> {
  const skipCluster = options.skipCluster === true;

  let fingerprintDupesRemoved = 0;
  let clustersMerged = 0;
  let clusterMembersRemoved = 0;
  let reverified = 0;

  // 1. Fingerprint intra-run dedupe
  try {
    fingerprintDupesRemoved = await dedupFindingsWithinRun(reviewRunId);
  } catch (err) {
    console.error(`[publish] fingerprint dedupe failed for run ${reviewRunId}:`, err);
  }

  // 2–3. Root-cause cluster + re-verify survivors
  if (!skipCluster) {
    try {
      let prId = options.prId;
      if (!prId) {
        const run = await prisma.reviewRun.findUnique({
          where: { id: reviewRunId },
          select: { prId: true },
        });
        prId = run?.prId;
      }
      // Only clear structural verification when re-verify can re-stamp it.
      const canReverify = Boolean(options.repoPath && prId);
      const cluster = await applyRootCauseClusters(reviewRunId, {
        clearVerificationForReverify: canReverify,
      });
      clustersMerged = cluster.clustersMerged;
      clusterMembersRemoved = cluster.membersRemoved;

      if (cluster.reverifyIds.length > 0 && options.repoPath && prId) {
        reverified = await reverifySurvivors(
          cluster.reverifyIds,
          options.repoPath,
          prId,
        );
      }
    } catch (err) {
      console.error(`[publish] cluster/reverify failed for run ${reviewRunId}:`, err);
    }
  }

  // 4. Cross-run reconcile
  try {
    let prId = options.prId;
    if (!prId) {
      const run = await prisma.reviewRun.findUnique({
        where: { id: reviewRunId },
        select: { prId: true },
      });
      prId = run?.prId;
    }
    if (prId) {
      const reconciliation = await reconcileFindingsAcrossRuns(prId, reviewRunId);
      await persistReviewArtifact({
        reviewRunId,
        artifactKey: "reconciliation:final",
        kind: "reconciliation",
        content: reconciliation,
      });
    }
  } catch (err) {
    console.error(`[publish] reconcile failed for run ${reviewRunId}:`, err);
    throw err;
  }

  // 5. Load published set — errors propagate so large-PR aggregate cannot
  // complete with a false empty result (single-shot discards the return and
  // already wraps this call in best-effort try/catch).
  const findings = await loadPublishedFindings(reviewRunId);

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
