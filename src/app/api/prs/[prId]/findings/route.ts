import { NextResponse } from "next/server";
import { getActiveScan, getLatestCompletedReview, getRecentRuns } from "@/src/lib/reviewFreshness";
import { computeStability, computeWeightedStability } from "@/src/lib/stabilityScore";
import { lookupTrustWeight } from "@/src/lib/modelTrustWeights";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { prisma } from "@/src/lib/prisma";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";

const CHUNK_SELECT = {
  id: true,
  label: true,
  filePaths: true,
  status: true,
  skipReason: true,
  rating: true,
  summary: true,
  errorMessage: true,
  lineCount: true,
  touchesSecuritySensitive: true,
  startedAt: true,
  completedAt: true,
} as const;

/**
 * GET /api/prs/[prId]/findings
 *
 * Returns three views of the PR's review state:
 *
 * - `reviewRun` + `findings` + `chunks`: the latest COMPLETED run (the
 *   "current report"). Findings are filtered to exclude verifier-rejected.
 *   `chunks` are the per-chunk results for that completed run.
 * - `activeScan` + `activeChunks` + `activeFindings` + `activeIterations`:
 *   the currently in-progress run, if any. Lets the UI render live chunk
 *   progress, partial findings ("found so far"), and per-chunk iteration
 *   counts ("we're on round N") while the agentic loop is still running.
 *   Null/empty when no scan is active.
 * - `sizeProfile`: tier (normal/large/oversized) for the PR's current diff.
 *
 * `stale` is true when the PR's current PrFile diff doesn't match the
 * completed run's recorded diffHash (i.e. the diff has moved since the
 * review).
 */
export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: findings expose review content for the PR. proxy.ts
  // only checks cookie PRESENCE — validate the session against the DB.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { prId } = await params;

    const [latest, pr, files, activeScan] = await Promise.all([
      getLatestCompletedReview(prId),
      prisma.pullRequest.findUnique({
        where: { id: prId },
        select: {
          sourceBranch: true,
          targetBranch: true,
          repository: { select: { path: true, baseBranch: true } },
        },
      }),
      prisma.prFile.findMany({
        where: { prId },
        select: { filename: true, additions: true, deletions: true },
      }),
      getActiveScan(prId),
    ]);
    const commitCount = pr
      ? readPrCommitCount(
          pr.repository.path,
          pr.targetBranch || pr.repository.baseBranch || "main",
          pr.sourceBranch,
        )
      : null;
    const sizeProfile = computePrSizeProfile(files, commitCount);

    const chunks = latest.reviewRun
      ? await prisma.reviewChunk.findMany({
          where: { reviewRunId: latest.reviewRun.id },
          orderBy: { id: "asc" },
          select: CHUNK_SELECT,
        })
      : [];

    const activeChunks = activeScan.reviewRun
      ? await prisma.reviewChunk.findMany({
          where: { reviewRunId: activeScan.reviewRun.id },
          orderBy: { id: "asc" },
          select: CHUNK_SELECT,
        })
      : [];

    const activeScanView = activeScan.reviewRun
      ? {
          id: activeScan.reviewRun.id,
          prId: activeScan.reviewRun.prId,
          commitHash: activeScan.reviewRun.commitHash,
          diffHash: activeScan.reviewRun.diffHash,
          startedAt: activeScan.reviewRun.startedAt,
          triggerReason: activeScan.reviewRun.triggerReason,
          model: activeScan.reviewRun.model,
          chunksTotal: activeScan.reviewRun.chunksTotal,
          chunksCompleted: activeScan.reviewRun.chunksCompleted,
          chunksFailed: activeScan.reviewRun.chunksFailed,
          chunksSkipped: activeScan.reviewRun.chunksSkipped,
        }
      : null;

    // Active partial findings + iteration map. Empty when no scan active.
    // Returned alongside the completed-run findings so the UI can render
    // "found so far" while scanning, then swap to the final list on done.
    const activeFindings = activeScan.findings;
    const activeIterations = activeScan.iterationsByChunk;

    if (!latest.reviewRun) {
      return NextResponse.json({
        reviewRun: null,
        findings: [],
        rejectedFindings: [],
        rejectedCount: 0,
        regressions: [],
        stale: false,
        sizeProfile,
        stability: null,
        weightedStability: null,
        chunks,
        activeScan: activeScanView,
        activeChunks,
        activeFindings,
        activeIterations,
        message: "No completed review yet. Run a scan.",
      });
    }

    const ratingTrend = await getRecentRuns(prId, 5);
    const stability = computeStability(ratingTrend);
    const weighted = computeWeightedStability(ratingTrend, lookupTrustWeight);

    return NextResponse.json({
      weightedStability: weighted.weightedStability,
      weightedReadyToMerge: weighted.readyToMerge,
      reviewRun: {
        id: latest.reviewRun.id,
        commitHash: latest.reviewRun.commitHash,
        diffHash: latest.reviewRun.diffHash,
        completedAt: latest.reviewRun.completedAt,
        rating: latest.reviewRun.rating,
        model: latest.reviewRun.model,
        triggerReason: latest.reviewRun.triggerReason,
        reliability: latest.reviewRun.reliability,
        refused: latest.reviewRun.refused,
        refusalNote: latest.reviewRun.refusalNote,
        chunksTotal: latest.reviewRun.chunksTotal,
        chunksCompleted: latest.reviewRun.chunksCompleted,
        chunksFailed: latest.reviewRun.chunksFailed,
        chunksSkipped: latest.reviewRun.chunksSkipped,
        tokensUsed: latest.reviewRun.tokensUsed ?? null,
      },
      findings: latest.findings,
      rejectedFindings: latest.rejectedFindings,
      rejectedCount: latest.rejectedCount,
      regressions: latest.regressions,
      stale: latest.stale,
      stability,
      sizeProfile,
      chunks,
      activeScan: activeScanView,
      activeChunks,
      activeFindings,
      activeIterations,
    });
  } catch (err: any) {
    console.error("Error fetching findings for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
