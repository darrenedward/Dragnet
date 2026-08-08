import { prisma } from "@/src/lib/prisma";
import { publishFindingsForRun } from "./publishFindings";
import type { ReviewReliability } from "./types";
import { completePrReviewIfCurrent } from "@/src/lib/prRevisionStatus";
import { recordFixesForCompletedScan } from "@/src/services/findingLifecycle/bugFixTracker";
import { getChunkCoverage } from "@/src/lib/chunkCoverage";

export interface AggregatedReviewResult {
  reliability: ReviewReliability;
  rating: number | null;
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  chunksSkipped: number;
  chunksIncomplete: number;
  findings: any[];
  skippedReasons: string[];
}

export async function aggregateResults(reviewRunId: string): Promise<AggregatedReviewResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: {
      id: true,
      prId: true,
      repoId: true,
      commitHash: true,
      model: true,
      pullRequest: { select: { sourceBranch: true } },
    },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const chunks = await prisma.reviewChunk.findMany({
    where: { reviewRunId },
    orderBy: { id: "asc" },
  });

  const coverage = getChunkCoverage(chunks);
  const { chunksTotal, chunksCompleted, chunksFailed, chunksSkipped, chunksIncomplete } = coverage;
  const incompleteSecurity = chunks.some(
    (chunk) =>
      chunk.touchesSecuritySensitive &&
      chunk.status !== "completed",
  );
  const reliability: ReviewReliability = incompleteSecurity
    ? "incomplete_security_review"
    : chunksIncomplete > 0 || chunksFailed > 0 || chunksSkipped > 0
      ? "partial"
      : "complete";
  const rating = chunksIncomplete > 0 || reliability === "incomplete_security_review"
    ? null
    : weightedRating(chunks);

  // Post-aggregate publish seam (shared with single-shot):
  // fingerprint dedupe → (optional cluster) → re-verify → reconcile → load.
  const repo = await prisma.repository.findUnique({
    where: { id: run.repoId },
    select: { path: true, localPath: true },
  });
  const repoPath = repo?.localPath || repo?.path || null;
  const published = await publishFindingsForRun(reviewRunId, {
    prId: run.prId,
    repoPath,
  });
  const findings = published.findings;

  const skippedReasons = chunks
    .filter((chunk) => chunk.status === "skipped")
    .map((chunk) => `${chunk.label}: ${chunk.skipReason || "skipped"}`);

  const isComplete = chunksIncomplete === 0;
  await prisma.reviewRun.update({
    where: { id: reviewRunId },
    data: {
      ...(isComplete ? { status: "completed", completedAt: new Date() } : {}),
      rating,
      reliability,
      chunksTotal,
      chunksCompleted,
      chunksFailed,
      chunksSkipped,
      ...(isComplete
        ? {}
        : { systemWarn: `Review incomplete: ${chunksCompleted}/${chunksTotal} chunks reached a terminal state.` }),
    },
  });

  if (!isComplete) {
    return {
      reliability,
      rating,
      chunksTotal,
      chunksCompleted,
      chunksFailed,
      chunksSkipped,
      chunksIncomplete,
      findings,
      skippedReasons,
    };
  }

  // Large-PR runs reconcile findings here rather than in reviewService's
  // normal path, so they must also feed the cross-scan fix ledger here.
  await recordFixesForCompletedScan(reviewRunId);

  await completePrReviewIfCurrent(run.prId, run.commitHash, rating);

  const historyId = `rev-${reviewRunId}`;
  const existingHistory = await prisma.reviewHistory.findUnique({ where: { id: historyId } });
  if (!existingHistory) {
    await prisma.reviewHistory.create({
      data: {
        id: historyId,
        repoId: run.repoId,
        repoName: run.repoId,
        branch: run.pullRequest.sourceBranch,
        commitHash: run.commitHash,
        triggerReason: `Large PR Mode via ${run.model || "unknown model"}`,
        status: "done",
        timestamp: new Date().toISOString(),
      },
    });
    await prisma.repository.updateMany({
      where: { id: run.repoId },
      data: { reviewsCount: { increment: 1 }, status: "idle" },
    });
  } else {
    await prisma.repository.updateMany({
      where: { id: run.repoId },
      data: { status: "idle" },
    });
  }

  return {
    reliability,
    rating,
    chunksTotal,
    chunksCompleted,
    chunksFailed,
    chunksSkipped,
    chunksIncomplete,
    findings,
    skippedReasons,
  };
}

function weightedRating(chunks: Array<{ status: string; rating: number | null; lineCount: number }>): number | null {
  const rated = chunks.filter((chunk) => chunk.status === "completed" && chunk.rating !== null && chunk.rating !== undefined);
  if (rated.length === 0) return null;
  const weightedTotal = rated.reduce((sum, chunk) => sum + (chunk.rating as number) * Math.max(1, chunk.lineCount), 0);
  const weight = rated.reduce((sum, chunk) => sum + Math.max(1, chunk.lineCount), 0);
  return Math.round(weightedTotal / weight);
}
