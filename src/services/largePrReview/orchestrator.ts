import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import {
  chunkOptionsFromLimits,
  readLimits,
  tierThresholdsFromLimits,
} from "@/src/lib/prSizeConfig";
import { runPrScan, type ScanResult, type PrManifestEntry, type RunPrScanOptions } from "@/src/services/reviewService";
import type { DeterministicFinding } from "@/src/services/deterministicChecks";
import type { ReviewTree } from "@/src/lib/reviewTree";
import type { TipOverlay } from "@/src/lib/tipOverlay";
import { aggregateResults } from "./aggregator";
import { chunkDiff } from "./chunker";
import { assertTier, buildDiffManifest } from "./manifest";
import { runGlobalDeterministicChecks } from "./globalDeterministicChecks";
import { appendReport, formatReportLine } from "./reportLogger";
import { getInstallationToken } from "@/src/lib/githubApp";
import { resolveSymbolsBatch, buildFindingFingerprint } from "./fingerprint";
import { persistGlobalDeterministicFindings } from "./persistence/globalDeterministicFindings";
import type {
  ChunkPlan,
  DiffManifest,
  LargePrReviewResult,
  LargePrTier,
  ReviewFileInput,
} from "./types";
import { completePrReviewIfCurrent } from "@/src/lib/prRevisionStatus";
import { readCheckpoint, type CheckpointState } from "@/src/services/checkpointStore";
import { readLatestReviewCheckpoint } from "@/src/services/durableScanState";

type ChunkRunner = (
  prId: string,
  files: ReviewFileInput[],
  reviewRunId: string,
  reviewChunkId: string,
  prManifest?: PrManifestEntry[],
  options?: RunPrScanOptions,
) => Promise<ScanResult>;

/**
 * Cheap run-state probe. Returns true iff the ReviewRun row is still
 * `in_progress`. Used at the top of each chunk-loop iteration to bail
 * out early when something else (concurrent scan with force=true,
 * aggregateResults from a parallel call, manual DB intervention) has
 * already closed the run. Without this, every remaining chunk burns
 * the full provider chain (~10 min on a hung NVIDIA finalizer) before
 * discovering via assertReviewRunStillActive that the run is over.
 */
async function isRunStillActive(reviewRunId: string): Promise<boolean> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { status: true },
  });
  return run?.status === "in_progress";
}

/**
 * Match the error message thrown by `assertReviewRunStillActive` in
 * reviewService.ts. String-match rather than instanceof because the
 * sentinel lives in a different module and we don't want to couple the
 * orchestrator to reviewService's error taxonomy.
 */
function isRunClosedError(err: Error): boolean {
  return /Review run is no longer active/i.test(err.message);
}

export interface RunLargePrReviewOptions {
  reviewRunId: string;
  prId: string;
  files: ReviewFileInput[];
  tier?: LargePrTier;
  warning?: string | null;
  runner?: ChunkRunner;
  /**
   * Phase 4 abort signal — threaded into every per-chunk runner call so
   * force-restart cancels the in-flight chunk's SDK request. Each chunk
   * that aborts returns a typed interrupted ScanResult and the orchestrator
   * treats it as an incomplete chunk (Phase 5 will add per-chunk resume).
   */
  signal?: AbortSignal;
  /**
   * Phase 5 resume — checkpoint metadata, threaded into every chunk's
   * runner call so per-iteration checkpoints carry the hash trio. Resume
   * validates all three against the current PR state before loading.
   */
  checkpointMetadata?: {
    commitHash: string;
    diffHash: string;
    reviewConfigHash: string;
  };
  /** Tip-bound review tree shared across chunks for readFile. */
  reviewTree?: ReviewTree;
  /** Tip overlay index shared across chunks for search/callers/similar. */
  tipOverlay?: TipOverlay;
}

const CHUNK_LEASE_MS = 30 * 60 * 1000;

export async function claimChunk(reviewRunId: string, chunkId: string, workerId: string): Promise<number | null> {
  const now = new Date();
  const result = await prisma.reviewChunk.updateMany({
    where: {
      id: chunkId,
      reviewRunId,
      OR: [
        { status: { in: ["pending", "failed", "interrupted"] } },
        { status: "running", leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + CHUNK_LEASE_MS),
      leaseVersion: { increment: 1 },
      attemptCount: { increment: 1 },
      startedAt: now,
      completedAt: null,
      errorMessage: null,
      skipReason: null,
    },
  });
  if (result.count !== 1) return null;
  const claimed = await prisma.reviewChunk.findUnique({
    where: { id: chunkId },
    select: { leaseVersion: true },
  });
  return claimed?.leaseVersion ?? null;
}

export async function releaseChunk(
  reviewRunId: string,
  chunkId: string,
  workerId: string,
  leaseVersion: number,
  data: Record<string, unknown>,
): Promise<boolean> {
  const result = await prisma.reviewChunk.updateMany({
    where: { id: chunkId, reviewRunId, leaseOwner: workerId, leaseVersion },
    data: { ...data, leaseOwner: null, leaseExpiresAt: null },
  });
  return result.count === 1;
}

export async function renewChunk(reviewRunId: string, chunkId: string, workerId: string, leaseVersion: number): Promise<boolean> {
  const result = await prisma.reviewChunk.updateMany({
    where: { id: chunkId, reviewRunId, leaseOwner: workerId, leaseVersion },
    data: { leaseExpiresAt: new Date(Date.now() + CHUNK_LEASE_MS) },
  });
  return result.count === 1;
}

async function loadCompletedChunkContext(reviewRunId: string, excludeChunkId: string): Promise<string> {
  try {
    const chunks = await prisma.reviewChunk.findMany({
      where: { reviewRunId, status: "completed", id: { not: excludeChunkId } },
      orderBy: { id: "asc" },
      select: { id: true, label: true, rating: true, summary: true },
    });
    const findingDelegate = (prisma as any).reviewFinding;
    const findings = findingDelegate?.findMany
      ? await findingDelegate.findMany({
          where: { reviewRunId, reviewChunkId: { in: chunks.map((chunk: any) => chunk.id) } },
          select: { reviewChunkId: true, filename: true, line: true, severity: true, explanation: true },
        })
      : [];
    return JSON.stringify({ chunks, findings });
  } catch (error) {
    console.warn(`[large-pr] failed to load completed chunk context:`, error);
    return "";
  }
}

async function loadGlobalDeterministicFindings(reviewRunId: string): Promise<DeterministicFinding[]> {
  const findingDelegate = (prisma as any).reviewFinding;
  if (!findingDelegate?.findMany) return [];
  try {
    const rows = await findingDelegate.findMany({
      where: { reviewRunId, reviewChunkId: null },
      select: { filename: true, line: true, severity: true, category: true, explanation: true, diffSuggestion: true, source: true },
      orderBy: { id: "asc" },
    });
    return rows.map((row: any) => ({
      filename: row.filename,
      line: row.line ?? undefined,
      severity: row.severity === "blocker" ? "error" : row.severity === "warning" ? "warning" : "info",
      category: row.category,
      explanation: row.explanation,
      diffSuggestion: row.diffSuggestion ?? undefined,
      source: row.source ?? "deterministic",
    }));
  } catch (error) {
    console.warn(`[large-pr] failed to load global deterministic findings:`, error);
    return [];
  }
}

async function loadChunkCheckpoint(
  repoPath: string,
  repoId: string,
  reviewRunId: string,
  chunkId: string,
  metadata?: { commitHash: string; diffHash: string; reviewConfigHash: string },
): Promise<CheckpointState | null> {
  const checkpoint = readCheckpoint(repoPath, reviewRunId, chunkId, repoId)
    ?? await readLatestReviewCheckpoint(reviewRunId, chunkId);
  if (!checkpoint || !metadata) return checkpoint;
  return checkpoint.commitHash === metadata.commitHash
    && checkpoint.diffHash === metadata.diffHash
    && checkpoint.reviewConfigHash === metadata.reviewConfigHash
    ? checkpoint
    : null;
}

export async function runLargePrReview({
  reviewRunId,
  prId,
  files,
  tier,
  warning,
  runner = runPrScan,
  signal,
  checkpointMetadata,
  reviewTree,
  tipOverlay,
}: RunLargePrReviewOptions): Promise<LargePrReviewResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: {
      repoId: true,
      pullRequest: { select: { sourceBranch: true } },
      commitHash: true,
    },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const repo = await prisma.repository.findUnique({
    where: { id: run.repoId },
    select: { securitySensitivePaths: true, path: true, installationId: true },
  });
  const repoPath = repo?.path ?? "";
  const installationId = repo?.installationId;
  const limits = readLimits();
  const thresholds = tierThresholdsFromLimits(limits);
  const chunkOpts = chunkOptionsFromLimits(limits);
  let manifest = buildDiffManifest(files, undefined, thresholds);

  // Greptile-style tail-skip: when maxFilesPerReview > 0 and the PR has
  // more code files than the cap, keep the largest N and drop the rest.
  // Drops happen BEFORE chunkDiff so the chunker never plans around
  // files that won't be reviewed.
  const tailSkipResult = applyTailSkip(manifest, limits.maxFilesPerReview);
  manifest = tailSkipResult.manifest;
  const tailSkipWarning = tailSkipResult.skipped.length > 0
    ? composeTailSkipWarning(tailSkipResult.skipped, limits.maxFilesPerReview)
    : null;

  // Re-assert with the same live thresholds (not bare engine constants).
  const tierResult = assertTier(manifest, thresholds);
  const effectiveTier = tier ?? tierResult.tier;
  const baseWarning = warning ?? ("message" in tierResult ? tierResult.message : null);
  const effectiveWarning = [baseWarning, tailSkipWarning].filter(Boolean).join(" · ") || null;
  const plans = chunkDiff(
    manifest,
    repo?.securitySensitivePaths ?? [],
    chunkOpts,
  );

  await logRun(prId, reviewRunId, repoPath, `Large PR Mode activated: ${plans.length} chunk${plans.length === 1 ? "" : "s"} (${manifest.codeLines.toLocaleString()} code lines)`, "info");
  if (effectiveWarning) await logRun(prId, reviewRunId, repoPath, effectiveWarning, "warn");

  const existingChunks = await prisma.reviewChunk.findMany({
    where: { reviewRunId },
    select: { id: true, status: true },
  });
  const desiredChunkIds = plans.map((plan) => chunkDbId(reviewRunId, plan.id)).sort();
  const existingChunkIds = existingChunks.map((chunk) => chunk.id).sort();
  const chunkPlanUnchanged = desiredChunkIds.length === existingChunkIds.length &&
    desiredChunkIds.every((id, index) => id === existingChunkIds[index]);
  if (!chunkPlanUnchanged) {
    await prisma.reviewChunk.deleteMany({ where: { reviewRunId } });
  }
  if (plans.length > 0 && !chunkPlanUnchanged) {
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
        rating: null,
        reliability: "complete",
        chunksTotal: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksSkipped: 0,
      },
    });
    await completePrReviewIfCurrent(prId, run.commitHash, null);
    return {
      success: true,
      rating: null,
      findings: [],
      usedModel: "large-pr-mode",
      systemWarn: "No code files to review — all changes are documentation, generated, or lockfile changes",
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

  // Run Tier 1 (tsc/eslint) + Tier 2 (containerized checks) ONCE before the
  // chunk loop. Each chunk receives these pre-computed findings and skips
  // its own deterministic scan — avoiding N redundant runs of the same
  // compiler/linter/container tests. Infrastructure failure aborts the
  // entire large-PR scan (no chunks run), matching existing behaviour in
  // normal-sized PR scans (AC: "Infrastructure failure stops the scan").
  const globalChecks = await runGlobalDeterministicChecks(reviewRunId, prId);
  if (globalChecks.abort) {
    await logRun(
      prId,
      reviewRunId,
      repoPath,
      `Global deterministic checks failed with infrastructure error: ${globalChecks.errorMessage ?? "unknown"}`,
      "error",
    );
    await prisma.reviewRun.update({
      where: { id: reviewRunId },
      data: { status: "failed", completedAt: new Date(), reliability: "partial" },
    });
    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: "Failed" } });
    return {
      success: false,
      rating: null,
      findings: globalChecks.findings,
      usedModel: "none",
      systemWarn: `Global deterministic checks failed: ${globalChecks.errorMessage ?? "infrastructure failure"}`,
      largePrMode: true,
      tier: effectiveTier,
      reliability: "partial",
      chunksTotal: plans.length,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksSkipped: 0,
      warning: effectiveWarning,
    };
  }
  await logRun(
    prId,
    reviewRunId,
    repoPath,
    `Global deterministic checks: ${globalChecks.findings.length} finding(s) — results shared across ${plans.length} chunk(s)`,
    "info",
  );

  // Persist global deterministic findings ONCE with reviewChunkId: null.
  // Each chunk will receive these via precomputedFindings but they will NOT
  // be re-persisted per-chunk — avoiding N redundant DB writes.
  await persistGlobalDeterministicFindings(
    reviewRunId,
    prId,
    run.repoId,
    globalChecks.findings,
  );

  let consecutiveErrorKey: string | null = null;
  let consecutiveErrorCount = 0;
  const workerId = `large-pr-${randomUUID()}`;

  for (const plan of plans) {
    const chunkId = chunkDbId(reviewRunId, plan.id);
    const existingChunk = existingChunks.find((chunk) => chunk.id === chunkId);
    if (chunkPlanUnchanged && existingChunk?.status === "completed") {
      await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: preserved completed result`, "info", chunkId);
      continue;
    }
    // Bail out if a concurrent path (force=true scan, manual DB write,
    // parallel retry call) has already closed this run. Without this,
    // every remaining chunk burns the full provider chain (~10 min per
    // chunk on a hung provider) before discovering via the runner's
    // assertReviewRunStillActive that the run is over.
    if (!(await isRunStillActive(reviewRunId))) {
      await logRun(prId, reviewRunId, repoPath, `Aborting chunk loop: run ${reviewRunId} is no longer in_progress`, "warn");
      break;
    }
    if (consecutiveErrorKey && consecutiveErrorCount >= 3) {
      await markSkipped(reviewRunId, chunkId, `Circuit breaker: repeated ${consecutiveErrorKey}`);
      continue;
    }

    // Refresh the GitHub installation token before each chunk to ensure
    // it hasn't expired during long-running scans (e.g., multi-chunk PRs
    // that span hours). The token is cached for 50 minutes, so this is
    // efficient but ensures fresh tokens between chunks.
    if (installationId) {
      try {
        await getInstallationToken(installationId);
      } catch (err) {
        // Log a warning but continue - the chunk may still succeed with
        // the cached token, or fail with a clearer error message.
        const message = err instanceof Error ? err.message : String(err);
        await logRun(
          prId,
          reviewRunId,
          repoPath,
          `Failed to refresh installation token: ${message}. Continuing with cached token if available.`,
          "warn",
        );
      }
    }

    const leaseVersion = await claimChunk(reviewRunId, chunkId, workerId);
    if (leaseVersion === null) {
      await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: another worker owns the lease`, "info", chunkId);
      continue;
    }
    await updateChunkCounters(reviewRunId);
    await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: scanning ${plan.label} (${plan.lineCount} lines)`, "info", chunkId);

    const checkpoint = await loadChunkCheckpoint(repoPath, run.repoId, reviewRunId, chunkId, checkpointMetadata);
    const result = await runChunkWithRetry({
      prId,
      reviewRunId,
      repoPath,
      chunkId,
      plan,
      runner,
      prManifest: buildPrManifest(files),
      signal,
      checkpointMetadata,
      precomputedFindings: globalChecks.findings,
      completedChunkContext: await loadCompletedChunkContext(reviewRunId, chunkId),
      workerId,
      leaseVersion,
      initialMessages: checkpoint?.messages,
      startLoopCount: checkpoint?.loopCount,
      reviewTree,
      tipOverlay,
    });
    if (result.ok === true) {
      // Phase 4: if a chunk returned the typed interrupted variant, stop
      // scheduling further chunks. The orchestrator returns an interrupted
      // LargePrReviewResult so the route surfaces the right JSON. Phase 5
      // persists per-chunk `lastCheckpointAt` for resume and marks the
      // chunk `interrupted` (distinct from `failed`) so chunked-run
      // aggregations can tell "this chunk can be resumed" from "this
      // chunk genuinely failed and needs a full re-run".
      if (result.scan.interrupted) {
        await releaseChunk(reviewRunId, chunkId, workerId, leaseVersion, {
            status: "interrupted",
            completedAt: new Date(),
            errorMessage: result.scan.message ?? "Chunk interrupted",
        }).catch(() => false);
        await updateChunkCounters(reviewRunId);
        await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: interrupted — aborting remaining chunks`, "warn", chunkId);
        const aggregated = await aggregateResults(reviewRunId);
        return {
          success: false,
          interrupted: true,
          rating: null,
          findings: [],
          usedModel: result.scan.usedModel,
          systemWarn: result.scan.message ?? null,
          largePrMode: true,
          tier: effectiveTier,
          reliability: "partial",
          chunksTotal: aggregated.chunksTotal,
          chunksCompleted: aggregated.chunksCompleted,
          chunksFailed: aggregated.chunksFailed,
          chunksSkipped: aggregated.chunksSkipped,
          recoverable: !aggregated.terminalized,
          warning: effectiveWarning,
        };
      }
      consecutiveErrorKey = null;
      consecutiveErrorCount = 0;
      await releaseChunk(reviewRunId, chunkId, workerId, leaseVersion, {
          status: "completed",
          completedAt: new Date(),
          rating: result.scan.rating,
          summary: result.scan.summary || `${result.scan.findings.length} finding${result.scan.findings.length === 1 ? "" : "s"}`,
          errorMessage: null,
      });
      await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: completed rating=${result.scan.rating ?? "null"}`, "info", chunkId);
    } else {
      const errorKey = normalizeError(result.error.message);
      consecutiveErrorCount = consecutiveErrorKey === errorKey ? consecutiveErrorCount + 1 : 1;
      consecutiveErrorKey = errorKey;
      await releaseChunk(reviewRunId, chunkId, workerId, leaseVersion, {
          status: "failed",
          completedAt: new Date(),
          errorMessage: result.error.message,
      });
      await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: failed after retry — ${result.error.message}`, "error", chunkId);
    }
    await updateChunkCounters(reviewRunId);
  }

  const aggregated = await aggregateResults(reviewRunId);
  await logRun(
    prId,
    reviewRunId,
    repoPath,
    `Large PR Mode completed: ${aggregated.reliability}, rating=${aggregated.rating ?? "null"}, chunks ${aggregated.chunksCompleted}/${aggregated.chunksTotal}`,
    aggregated.reliability === "complete" ? "info" : "warn",
  );

  return {
    success: aggregated.terminalized,
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
    recoverable: !aggregated.terminalized,
  };
}

export async function retryFailedChunks(
  reviewRunId: string,
  runner: ChunkRunner = runPrScan,
): Promise<LargePrReviewResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { id: true, prId: true, repoId: true, commitHash: true, diffHash: true, reviewConfigHash: true },
  });
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);

  const repo = await prisma.repository.findUnique({
    where: { id: run.repoId },
    select: { path: true, installationId: true },
  });
  const repoPath = repo?.path ?? "";
  const installationId = repo?.installationId;
  const workerId = `large-pr-retry-${randomUUID()}`;

  // Resume scope: any chunk not in a terminal state. Covers failed retries,
  // pending chunks that never started, and `running` chunks left dangling
  // by a dev-server restart mid-scan. Phase 5: `interrupted` chunks also
  // count as resumable — they have checkpoint state and a fresh run can
  // pick up where the previous one left off.
  const resumableChunks = await prisma.reviewChunk.findMany({
    where: { reviewRunId, status: { in: ["failed", "pending", "running", "interrupted"] } },
    orderBy: { id: "asc" },
  });
  if (resumableChunks.length === 0) {
    const aggregated = await aggregateResults(reviewRunId);
    return {
      success: aggregated.terminalized,
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
      recoverable: !aggregated.terminalized,
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
    // Same bail-out as orchestrate(). The retry path is especially
    // vulnerable to this race because the user may have triggered a
    // fresh scan (force=true) while this retry was iterating, and the
    // new scan's aggregateResults closes this run out from under us.
    if (!(await isRunStillActive(reviewRunId))) {
      await logRun(run.prId, reviewRunId, repoPath, `Aborting retry chunk loop: run ${reviewRunId} is no longer in_progress`, "warn");
      break;
    }
    const files = prFiles.filter((file) => chunk.filePaths.includes(file.filename));

    // Refresh the GitHub installation token before each chunk retry.
    if (installationId) {
      try {
        await getInstallationToken(installationId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logRun(
          run.prId,
          reviewRunId,
          repoPath,
          `Failed to refresh installation token during retry: ${message}. Continuing with cached token if available.`,
          "warn",
        );
      }
    }

    const leaseVersion = await claimChunk(reviewRunId, chunk.id, workerId);
    if (leaseVersion === null) {
      await logRun(run.prId, reviewRunId, repoPath, `Chunk ${chunk.id}: another worker owns the lease`, "info", chunk.id);
      continue;
    }
    await updateChunkCounters(reviewRunId);
    const checkpoint = await loadChunkCheckpoint(repoPath, run.repoId, reviewRunId, chunk.id, {
      commitHash: run.commitHash,
      diffHash: run.diffHash,
      reviewConfigHash: run.reviewConfigHash,
    });
    const completedChunkContext = await loadCompletedChunkContext(reviewRunId, chunk.id);
    const result = await runChunkWithRetry({
      prId: run.prId,
      reviewRunId,
      repoPath,
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
      checkpointMetadata: {
        commitHash: run.commitHash,
        diffHash: run.diffHash,
        reviewConfigHash: run.reviewConfigHash,
      },
      precomputedFindings: await loadGlobalDeterministicFindings(reviewRunId),
      completedChunkContext,
      workerId,
      leaseVersion,
      initialMessages: checkpoint?.messages,
      startLoopCount: checkpoint?.loopCount,
    });
    if (result.ok === true && result.scan.interrupted) {
      await releaseChunk(reviewRunId, chunk.id, workerId, leaseVersion, {
        status: "interrupted",
        completedAt: new Date(),
        errorMessage: result.scan.message ?? "Chunk interrupted",
      });
      await updateChunkCounters(reviewRunId);
      await logRun(run.prId, reviewRunId, repoPath, `Chunk ${chunk.id}: interrupted — leaving retry incomplete`, "warn", chunk.id);
      break;
    }
    if (result.ok === true) {
      await releaseChunk(reviewRunId, chunk.id, workerId, leaseVersion, {
          status: "completed",
          completedAt: new Date(),
          rating: result.scan.rating,
          summary: result.scan.summary || `${result.scan.findings.length} finding${result.scan.findings.length === 1 ? "" : "s"}`,
          errorMessage: null,
      });
    } else {
      await releaseChunk(reviewRunId, chunk.id, workerId, leaseVersion, {
          status: "failed",
          completedAt: new Date(),
          errorMessage: result.error.message,
      });
    }
    await updateChunkCounters(reviewRunId);
  }

  const aggregated = await aggregateResults(reviewRunId);
  return {
    success: aggregated.terminalized,
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
    recoverable: !aggregated.terminalized,
  };
}

async function runChunkWithRetry({
  prId,
  reviewRunId,
  repoPath,
  chunkId,
  plan,
  runner,
  prManifest,
  signal,
  checkpointMetadata,
  precomputedFindings,
  completedChunkContext,
  workerId,
  leaseVersion,
  initialMessages,
  startLoopCount,
  reviewTree,
  tipOverlay,
}: {
  prId: string;
  reviewRunId: string;
  repoPath: string;
  chunkId: string;
  plan: ChunkPlan;
  runner: ChunkRunner;
  prManifest?: PrManifestEntry[];
  signal?: AbortSignal;
  checkpointMetadata?: { commitHash: string; diffHash: string; reviewConfigHash: string };
  precomputedFindings?: DeterministicFinding[];
  completedChunkContext?: string;
  workerId: string;
  leaseVersion: number;
  initialMessages?: RunPrScanOptions["initialMessages"];
  startLoopCount?: number;
  reviewTree?: ReviewTree;
  tipOverlay?: TipOverlay;
}): Promise<{ ok: true; scan: ScanResult } | { ok: false; error: Error }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const heartbeat = setInterval(() => {
      void renewChunk(reviewRunId, chunkId, workerId, leaseVersion);
    }, 60_000);
    try {
      const scan = await runner(prId, plan.files, reviewRunId, chunkId, prManifest, {
        signal,
        checkpointMetadata,
        precomputedFindings,
        completedChunkContext,
        ...(initialMessages ? { initialMessages } : {}),
        ...(startLoopCount !== undefined ? { startLoopCount } : {}),
        reviewTree,
        tipOverlay,
      });
      return { ok: true, scan };
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await logRun(prId, reviewRunId, repoPath, `Chunk ${plan.id}: attempt ${attempt} failed — ${lastError.message}`, attempt === 1 ? "warn" : "error", chunkId);
      // If the run is no longer active, retrying is pointless — the
      // second attempt will hit the same wall after another full
      // provider-chain cycle (~10 min on a hung finalizer). Bail now
      // and let the orchestrator's loop-level check skip remaining chunks.
      if (isRunClosedError(lastError)) break;
    } finally {
      clearInterval(heartbeat);
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
  repoPath: string,
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
  // Disk mirror to <repoPath>/.dragnet/reports/<reviewRunId>.md so the
  // /dragnet report skill command can read the scan's history from inside
  // the scanned repo. Best-effort — appendReport swallows fs errors.
  await appendReport(
    repoPath,
    reviewRunId,
    formatReportLine({ message, level, chunkId: reviewChunkId }),
  );
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

/**
 * Greptile-style tail-skip: keep the largest N code files, drop the rest.
 * Docs, lockfiles, generated, and vendor files are never dropped — only
 * code files compete for the cap.
 *
 * Returns a new manifest with the dropped files removed + counters
 * re-derived. When cap is 0 or codeFileCount <= cap, returns the input
 * manifest unchanged + an empty skipped list.
 */
export function applyTailSkip(
  manifest: DiffManifest,
  maxFilesPerReview: number,
): { manifest: DiffManifest; skipped: string[] } {
  if (maxFilesPerReview <= 0) return { manifest, skipped: [] };
  const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
  if (codeFiles.length <= maxFilesPerReview) return { manifest, skipped: [] };

  // Sort by lineCount desc (ties broken alphabetically for determinism).
  const ranked = [...codeFiles].sort(
    (a, b) => b.lineCount - a.lineCount || a.filename.localeCompare(b.filename),
  );
  const keepSet = new Set(ranked.slice(0, maxFilesPerReview).map((f) => f.filename));
  const kept: typeof manifest.files = [];
  const skipped: string[] = [];
  for (const file of manifest.files) {
    if (file.fileClass === "code" && !keepSet.has(file.filename)) {
      skipped.push(file.filename);
      continue;
    }
    kept.push(file);
  }
  const codeKept = kept.filter((f) => f.fileClass === "code");
  const next: DiffManifest = {
    ...manifest,
    files: kept,
    totalLines: kept.reduce((s, f) => s + f.lineCount, 0),
    codeLines: codeKept.reduce((s, f) => s + f.lineCount, 0),
    codeFileCount: codeKept.length,
    // Re-derive the simple counters so the UI shows post-skip state.
    docsFileCount: kept.filter((f) => f.fileClass === "docs").length,
    generatedFileCount: kept.filter((f) => f.fileClass === "generated").length,
    lockFileCount: kept.filter((f) => f.fileClass === "lock").length,
    vendorFileCount: kept.filter((f) => f.fileClass === "vendor").length,
  };
  return { manifest: next, skipped };
}

function composeTailSkipWarning(skipped: string[], cap: number): string {
  const preview = skipped.slice(0, 8).join(", ");
  const more = skipped.length > 8 ? ` (+${skipped.length - 8} more)` : "";
  return `${skipped.length} code file${skipped.length === 1 ? "" : "s"} not reviewed (limit ${cap}): ${preview}${more}`;
}
