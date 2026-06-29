import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import { readLimits } from "@/src/lib/prSizeConfig";
import { runPrScan, type ScanResult, type PrManifestEntry } from "@/reviewService";
import { aggregateResults } from "./aggregator";
import { chunkDiff } from "./chunker";
import { assertTier, buildDiffManifest } from "./manifest";
import type {
  ChunkPlan,
  LargePrReviewResult,
  LargePrTier,
  ReviewFileInput,
} from "./types";

type ChunkRunner = (
  prId: string,
  files: ReviewFileInput[],
  reviewRunId: string,
  reviewChunkId: string,
  prManifest?: PrManifestEntry[],
) => Promise<ScanResult>;

export interface RunLargePrReviewOptions {
  reviewRunId: string;
  prId: string;
  files: ReviewFileInput[];
  tier?: LargePrTier;
  warning?: string | null;
  runner?: ChunkRunner;
}

export async function runLargePrReview({
  reviewRunId,
  prId,
  files,
  tier,
  warning,
  runner = runPrScan,
}: RunLargePrReviewOptions): Promise<LargePrReviewResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: {
      repoId: true,
      pullRequest: { select: { sourceBranch: true } },
    },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const repo = await prisma.repository.findUnique({
    where: { id: run.repoId },
    select: { securitySensitivePaths: true },
  });
  const limits = readLimits();
  const manifest = buildDiffManifest(files, undefined, {
    normalMaxLines: limits.normalMaxLines,
    normalMaxCodeFiles: limits.normalMaxCodeFiles,
    oversizedLines: limits.oversizedLines,
    oversizedCodeFiles: limits.oversizedCodeFiles,
  });
  const tierResult = assertTier(manifest);
  const effectiveTier = tier ?? tierResult.tier;
  const effectiveWarning = warning ?? ("message" in tierResult ? tierResult.message : null);
  const plans = chunkDiff(
    manifest,
    repo?.securitySensitivePaths ?? [],
    { chunkLineCap: limits.chunkLineCap, minUsefulChunkLines: limits.minUsefulChunkLines },
  );

  await logRun(prId, reviewRunId, `Large PR Mode activated: ${plans.length} chunk${plans.length === 1 ? "" : "s"} (${manifest.codeLines.toLocaleString()} code lines)`, "info");
  if (effectiveWarning) await logRun(prId, reviewRunId, effectiveWarning, "warn");

  await prisma.reviewChunk.deleteMany({ where: { reviewRunId } });
  if (plans.length > 0) {
    await prisma.reviewChunk.createMany({
      data: plans.map((plan) => ({
        id: chunkDbId(reviewRunId, plan.id),
        reviewRunId,
        label: plan.label,
        filePaths: plan.filePaths,
        status: "pending",
        lineCount: plan.lineCount,
        touchesSecuritySensitive: plan.touchesSecuritySensitive,
      })),
    });
  }
  await updateChunkCounters(reviewRunId);

  if (plans.length === 0) {
    await prisma.reviewRun.update({
      where: { id: reviewRunId },
      data: {
        status: "completed",
        completedAt: new Date(),
        rating: 10,
        reliability: "complete",
        chunksTotal: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksSkipped: 0,
      },
    });
    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "Completed", rating: 10 } });
    return {
      success: true,
      rating: 10,
      findings: [],
      usedModel: "large-pr-mode",
      largePrMode: true,
      tier: effectiveTier,
      reliability: "complete",
      chunksTotal: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksSkipped: 0,
      warning: effectiveWarning,
    };
  }

  let consecutiveErrorKey: string | null = null;
  let consecutiveErrorCount = 0;

  for (const plan of plans) {
    const chunkId = chunkDbId(reviewRunId, plan.id);
    if (consecutiveErrorKey && consecutiveErrorCount >= 3) {
      await markSkipped(reviewRunId, chunkId, `Circuit breaker: repeated ${consecutiveErrorKey}`);
      continue;
    }

    await prisma.reviewChunk.update({
      where: { id: chunkId },
      data: { status: "running", startedAt: new Date(), errorMessage: null, skipReason: null },
    });
    await updateChunkCounters(reviewRunId);
    await logRun(prId, reviewRunId, `Chunk ${plan.id}: scanning ${plan.label} (${plan.lineCount} lines)`, "info", chunkId);

    const result = await runChunkWithRetry({ prId, reviewRunId, chunkId, plan, runner, prManifest: buildPrManifest(files) });
    if (result.ok === true) {
      consecutiveErrorKey = null;
      consecutiveErrorCount = 0;
      await prisma.reviewChunk.update({
        where: { id: chunkId },
        data: {
          status: "completed",
          completedAt: new Date(),
          rating: result.scan.rating,
          summary: `${result.scan.findings.length} finding${result.scan.findings.length === 1 ? "" : "s"}`,
          errorMessage: null,
        },
      });
      await logRun(prId, reviewRunId, `Chunk ${plan.id}: completed rating=${result.scan.rating ?? "null"}`, "info", chunkId);
    } else {
      const errorKey = normalizeError(result.error.message);
      consecutiveErrorCount = consecutiveErrorKey === errorKey ? consecutiveErrorCount + 1 : 1;
      consecutiveErrorKey = errorKey;
      await prisma.reviewChunk.update({
        where: { id: chunkId },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: result.error.message,
        },
      });
      await logRun(prId, reviewRunId, `Chunk ${plan.id}: failed after retry — ${result.error.message}`, "error", chunkId);
    }
    await updateChunkCounters(reviewRunId);
  }

  const aggregated = await aggregateResults(reviewRunId);
  await logRun(
    prId,
    reviewRunId,
    `Large PR Mode completed: ${aggregated.reliability}, rating=${aggregated.rating ?? "null"}, chunks ${aggregated.chunksCompleted}/${aggregated.chunksTotal}`,
    aggregated.reliability === "complete" ? "info" : "warn",
  );

  return {
    success: true,
    rating: aggregated.rating,
    findings: aggregated.findings,
    usedModel: "large-pr-mode",
    systemWarn: aggregated.reliability === "complete"
      ? null
      : aggregated.reliability === "incomplete_security_review"
        ? "Security-sensitive chunks failed or were skipped. Rating nulled because the review is incomplete."
        : "Some chunks failed or were skipped. Review is partial.",
    largePrMode: true,
    tier: effectiveTier,
    reliability: aggregated.reliability,
    chunksTotal: aggregated.chunksTotal,
    chunksCompleted: aggregated.chunksCompleted,
    chunksFailed: aggregated.chunksFailed,
    chunksSkipped: aggregated.chunksSkipped,
    warning: effectiveWarning,
  };
}

export async function retryFailedChunks(
  reviewRunId: string,
  runner: ChunkRunner = runPrScan,
): Promise<LargePrReviewResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { id: true, prId: true, repoId: true },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  // Resume scope: any chunk not in a terminal state. Covers failed retries,
  // pending chunks that never started, and `running` chunks left dangling
  // by a dev-server restart mid-scan.
  const resumableChunks = await prisma.reviewChunk.findMany({
    where: { reviewRunId, status: { in: ["failed", "pending", "running"] } },
    orderBy: { id: "asc" },
  });
  if (resumableChunks.length === 0) {
    const aggregated = await aggregateResults(reviewRunId);
    return {
      success: true,
      rating: aggregated.rating,
      findings: aggregated.findings,
      usedModel: "large-pr-mode",
      largePrMode: true,
      tier: "grouped",
      reliability: aggregated.reliability,
      chunksTotal: aggregated.chunksTotal,
      chunksCompleted: aggregated.chunksCompleted,
      chunksFailed: aggregated.chunksFailed,
      chunksSkipped: aggregated.chunksSkipped,
    };
  }

  await prisma.reviewRun.update({
    where: { id: reviewRunId },
    data: { status: "in_progress", completedAt: null },
  });
  await prisma.pullRequest.updateMany({ where: { id: run.prId }, data: { status: "In Progress" } });

  const prFiles = await prisma.prFile.findMany({
    where: { prId: run.prId },
    select: { filename: true, status: true, additions: true, deletions: true, originalContent: true, modifiedContent: true, diff: true },
  });

  for (const chunk of resumableChunks) {
    const files = prFiles.filter((file) => chunk.filePaths.includes(file.filename));
    await prisma.reviewChunk.update({
      where: { id: chunk.id },
      data: { status: "running", startedAt: new Date(), completedAt: null, errorMessage: null },
    });
    await updateChunkCounters(reviewRunId);
    const result = await runChunkWithRetry({
      prId: run.prId,
      reviewRunId,
      chunkId: chunk.id,
      plan: {
        id: chunk.id,
        label: chunk.label,
        files: files as any[],
        filePaths: chunk.filePaths,
        lineCount: chunk.lineCount,
        touchesSecuritySensitive: chunk.touchesSecuritySensitive,
      },
      runner,
      prManifest: buildPrManifest(prFiles),
    });
    if (result.ok === true) {
      await prisma.reviewChunk.update({
        where: { id: chunk.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          rating: result.scan.rating,
          summary: `${result.scan.findings.length} finding${result.scan.findings.length === 1 ? "" : "s"}`,
          errorMessage: null,
        },
      });
    } else {
      await prisma.reviewChunk.update({
        where: { id: chunk.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: result.error.message,
        },
      });
    }
    await updateChunkCounters(reviewRunId);
  }

  const aggregated = await aggregateResults(reviewRunId);
  return {
    success: true,
    rating: aggregated.rating,
    findings: aggregated.findings,
    usedModel: "large-pr-mode",
    largePrMode: true,
    tier: "grouped",
    reliability: aggregated.reliability,
    chunksTotal: aggregated.chunksTotal,
    chunksCompleted: aggregated.chunksCompleted,
    chunksFailed: aggregated.chunksFailed,
    chunksSkipped: aggregated.chunksSkipped,
  };
}

async function runChunkWithRetry({
  prId,
  reviewRunId,
  chunkId,
  plan,
  runner,
  prManifest,
}: {
  prId: string;
  reviewRunId: string;
  chunkId: string;
  plan: ChunkPlan;
  runner: ChunkRunner;
  prManifest?: PrManifestEntry[];
}): Promise<{ ok: true; scan: ScanResult } | { ok: false; error: Error }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const scan = await runner(prId, plan.files, reviewRunId, chunkId, prManifest);
      return { ok: true, scan };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await logRun(prId, reviewRunId, `Chunk ${plan.id}: attempt ${attempt} failed — ${lastError.message}`, attempt === 1 ? "warn" : "error", chunkId);
    }
  }
  return { ok: false, error: lastError || new Error("Chunk scan failed.") };
}

/**
 * Build the simplified PR manifest passed to every chunk's review prompt.
 * Source: the full PR file list. Output: minimal {filename, additions,
 * deletions} entries (no diff content — keeps prompt size bounded).
 *
 * The preamble the LLM sees excludes the current chunk's files (it
 * already has those). See buildManifestPreamble in reviewService.ts.
 */
function buildPrManifest(files: ReviewFileInput[]): PrManifestEntry[] {
  return files.map((f) => ({
    filename: f.filename,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
}

async function markSkipped(reviewRunId: string, chunkId: string, reason: string): Promise<void> {
  await prisma.reviewChunk.update({
    where: { id: chunkId },
    data: { status: "skipped", skipReason: reason, completedAt: new Date() },
  });
  await updateChunkCounters(reviewRunId);
}

async function updateChunkCounters(reviewRunId: string): Promise<void> {
  const chunks = await prisma.reviewChunk.findMany({
    where: { reviewRunId },
    select: { status: true },
  });
  await prisma.reviewRun.update({
    where: { id: reviewRunId },
    data: {
      chunksTotal: chunks.length,
      chunksCompleted: chunks.filter((chunk) => chunk.status === "completed").length,
      chunksFailed: chunks.filter((chunk) => chunk.status === "failed").length,
      chunksSkipped: chunks.filter((chunk) => chunk.status === "skipped").length,
    },
  });
}

async function logRun(
  prId: string,
  reviewRunId: string,
  message: string,
  level = "info",
  reviewChunkId?: string,
): Promise<void> {
  try {
    await prisma.reviewLog.create({
      data: {
        id: randomUUID(),
        prId,
        reviewRunId,
        reviewChunkId: reviewChunkId ?? null,
        message,
        level,
      },
    });
  } catch {
    // best-effort progress log
  }
}

function chunkDbId(reviewRunId: string, planId: string): string {
  return `${reviewRunId}-${planId}`;
}

function normalizeError(message: string): string {
  return message
    .replace(/\d+/g, "#")
    .slice(0, 120)
    .toLowerCase();
}
