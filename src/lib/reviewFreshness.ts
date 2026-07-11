/**
 * Review freshness gate — mirrors the discriminated-union shape of
 * `assertIndexFresh` in `./indexFreshness.ts`.
 *
 * Two concepts:
 *
 * 1. **diffHash** — sha256 of the PR's current diff content (sorted by
 *    filename). Stable across rebases and merge commits as long as the
 *    actual changed code hasn't moved. Commit hashes change on every
 *    rebase; diff hashes don't.
 *
 * 2. **reviewConfigHash** — sha256 of the review engine version, ordered
 *    provider/model chain, system prompt hash, and review limits. If you
 *    swap models/providers, edit the prompt, or change the scan contract,
 *    this hash changes and any prior review is treated as stale.
 *
 * A completed ReviewRun is reusable (cache hit) only when its
 * (commitHash, diffHash, reviewConfigHash) all match the current values.
 *
 * Fail-open: hash computation never throws — malformed input returns a
 * sentinel empty string, which never matches a stored hash, so the scan
 * proceeds.
 */

import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import type { ReviewLimits } from "./prSizeConfig";
import type { RatingTrendEntry } from "./stabilityScore";

/**
 * Max wall-clock time a scan is allowed to run before being treated as
 * orphaned. Real scans typically finish in 2-8 min; the headroom absorbs
 * slow providers + large PRs. If a ReviewRun is older than this and still
 * `in_progress`, the process that started it is gone (dev server restart,
 * crash, OOM kill, serverless cold-start eviction) and the row is stale.
 *
 * Layer 2 (assertNoActiveScan) reaps on demand when a new scan would trip
 * on the orphan; Layer 3 (src/services/runReaper.ts) reaps on cold start.
 *
 * 5 min (was 30): dev-server restarts are common in this project, and a
 * 30-min wait before the UI's Force-restart path becomes useful was too
 * patient. Users reported "stuck scan, can't restart" inside that window.
 */
export const SCAN_STALE_AFTER_MS = 5 * 60 * 1000;

/** Minimal shape of what refreshPrFiles returns. Avoids a circular import. */
export interface DiffHashInput {
  filename: string;
  diff?: string | null;
}

export type ReviewFreshness =
  | { ok: true; runId: string; rating: number | null }
  | { ok: false; kind: "NO_RUN" | "STALE_RUN"; message: string };

export type ActiveScanCheck =
  | { ok: true }
  | {
      ok: false;
      runId: string;
      startedAt: Date;
      triggerReason: string | null;
      model: string | null;
    }
  | {
      /**
       * Phase 7 — stale in_progress run WITH a valid checkpoint. The
       * scan route returns HTTP 200 with this shape so the UI can offer
       * Continue / Start fresh. Resume is gated on the hash trio
       * matching; mismatches fall through to Start fresh.
       */
      ok: false;
      kind: "stale_inspectable";
      runId: string;
      startedAt: Date;
      commitHash: string;
      diffHash: string;
      reviewConfigHash: string;
      checkpointId: string;
      completedIterations: number;
      totalIterations: number;
      lastProvider: string | null;
      lastModel: string | null;
    };

export interface LatestReviewResult {
  reviewRun: {
    id: string;
    commitHash: string;
    diffHash: string;
    reviewConfigHash: string;
    completedAt: Date | null;
    rating: number | null;
    model: string | null;
    triggerReason: string | null;
    reliability: string | null;
    refused: boolean;
    refusalNote: string | null;
    outcome: string | null;
    status: string;
    chunksTotal: number;
    chunksCompleted: number;
    chunksFailed: number;
    chunksSkipped: number;
    tokensUsed: unknown | null;
  } | null;
  findings: Array<{
    id: string;
    prId: string;
    reviewRunId: string | null;
    repoId: string;
    category: string;
    severity: string;
    exploitability: string | null;
    impact: string | null;
    filename: string;
    line: number | null;
    explanation: string;
    diffSuggestion: string | null;
    evidenceChain: string | null;
    confidence: number | null;
    confidenceReason: string | null;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
    timestamp: string;
    isRegression: boolean | null;
    regressedFromRunId: string | null;
  }>;
  regressions: Array<{
    id: string;
    prId: string;
    reviewRunId: string | null;
    repoId: string;
    category: string;
    severity: string;
    exploitability: string | null;
    impact: string | null;
    filename: string;
    line: number | null;
    explanation: string;
    diffSuggestion: string | null;
    evidenceChain: string | null;
    confidence: number | null;
    confidenceReason: string | null;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
    timestamp: string;
    isRegression: boolean;
    regressedFromRunId: string | null;
  }>;
  rejectedCount: number;
  rejectedFindings: Array<{
    id: string;
    filename: string;
    line: number | null;
    severity: string;
    category: string;
    explanation: string;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
  }>;
  stale: boolean;
}

export interface ChatChainEntry {
  name: string;
  model: string;
  endpoint?: string;
  maxIterations?: number;
}

/**
 * Bump this when review semantics change without a SYSTEM_INSTRUCTION change:
 * tool schemas, finalizer transcript handling, verifier acceptance, chunk
 * prompt contracts, or provider request compatibility. This deliberately
 * invalidates old cached ReviewRuns so a manual scan does real work after
 * scanner behavior changes.
 */
export const REVIEW_ENGINE_CACHE_VERSION = "review-engine-v2-finalizer-safe-transcript";

/**
 * Hash a PR's diff content. Filters to files with non-empty diff,
 * sorts by filename for stability, concatenates with a separator,
 * sha256, first 16 hex chars.
 *
 * `commitHint` is mixed into the seed so two pushes of the same PR to
 * different commits CANNOT produce the same hash even if the resulting
 * patch text is byte-identical (e.g. cherry-picked to a new HEAD, or
 * a force-push that leaves the diff unchanged but moves the commit).
 * Without this, the cache would silently treat a different commit as
 * a cache hit; #13 reproduced exactly that — same diffHash, different
 * commits, stale findings reused.
 *
 * Pass `commitHint = ""` when no commit context is available — the
 * hash still works, just without the cross-commit collision guard.
 *
 * Returns "" on empty input (no files / no diffs) — callers should
 * treat this as "can't compute, don't cache" since it will never
 * match a stored hash.
 */
export function computeDiffHash(
  files: DiffHashInput[],
  commitHint: string = "",
): string {
  const withDiff = files
    .filter((f) => f.diff && f.diff.trim().length > 0)
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  if (withDiff.length === 0) return "";

  const diffSeed = withDiff
    .map((f) => `--- ${f.filename} ---\n${f.diff!.trim()}`)
    .join("\n\n");

  // Prefix the commit hint so any subsequent diff-text change after the
  // commit hint is part of the same hash space. Kept in a single update()
  // call so the hash is computed once.
  const seed = commitHint ? `commit:${commitHint}\n${diffSeed}` : diffSeed;

  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Hash the review configuration. Captures which LLM(s) and prompt
 * produced a review. If you swap models or change the prompt, the hash
 * changes and the cache invalidates.
 *
 * `systemPromptHash` is computed once per reviewService run and passed
 * in — reviewFreshness.ts doesn't need to know how the prompt is built.
 */
export function computeReviewConfigHash(
  chatChain: ChatChainEntry[],
  systemPromptHash: string,
  reviewLimits?: ReviewLimits,
): string {
  const models = chatChain
    .map((c) => ({
      name: c.name,
      endpoint: c.endpoint,
      model: c.model,
      maxIterations: c.maxIterations,
    }))
    .filter((c) => c.model)
    .map((c) => `${c.name || "provider"}:${c.endpoint || "endpoint"}:${c.model}:${c.maxIterations ?? "default"}`)
    .join(",");
  const limitsSeed = reviewLimits
    ? [
        reviewLimits.chunkLineCap,
        reviewLimits.minUsefulChunkLines,
        reviewLimits.normalMaxLines,
        reviewLimits.normalMaxCodeFiles,
        reviewLimits.oversizedLines,
        reviewLimits.oversizedCodeFiles,
        reviewLimits.maxFilesPerReview,
      ].join(",")
    : "default-limits";
  const seed = `${REVIEW_ENGINE_CACHE_VERSION}|${models}|${systemPromptHash}|${limitsSeed}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Short sha256 of an arbitrary string — used by callers (e.g. the scan
 * route) to hash the system prompt without depending on a particular
 * hash helper existing elsewhere.
 */
export function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Returns the latest completed ReviewRun for the given PR if its
 * (commitHash, diffHash, reviewConfigHash) all match the current
 * values. Otherwise returns a STALE_RUN or NO_RUN signal.
 *
 * Empty input hashes (from fail-open computeDiffHash) never match —
 * treated as STALE_RUN so the scan proceeds.
 */
export async function assertReviewFreshness(
  pr: { id: string; commitHash: string },
  currentDiffHash: string,
  currentConfigHash: string,
): Promise<ReviewFreshness> {
  const latest = await prisma.reviewRun.findFirst({
    where: { prId: pr.id, status: "completed" },
    orderBy: { completedAt: "desc" },
    select: {
      id: true,
      commitHash: true,
      diffHash: true,
      reviewConfigHash: true,
      rating: true,
      reliability: true,
    },
  });

  if (!latest) {
    return {
      ok: false,
      kind: "NO_RUN",
      message: "No completed review run for this PR yet.",
    };
  }

  const matches =
    latest.commitHash === pr.commitHash &&
    latest.diffHash === currentDiffHash &&
    latest.reviewConfigHash === currentConfigHash &&
    currentDiffHash !== ""; // empty hash = can't verify, don't cache

  const reusable =
    latest.rating !== null &&
    (latest.reliability === null || latest.reliability === "complete");

  if (matches && reusable) {
    return { ok: true, runId: latest.id, rating: latest.rating };
  }

  return {
    ok: false,
    kind: "STALE_RUN",
    message: !reusable
      ? `Prior review run is not reusable (rating=${latest.rating ?? "null"}, reliability=${latest.reliability ?? "unknown"}).`
      : `Prior review run was for commit ${latest.commitHash.slice(0, 7)} ` +
        `(diffHash ${latest.diffHash.slice(0, 8) || "(unknown)"}). ` +
        `Current state: commit ${pr.commitHash.slice(0, 7)}, diffHash ${currentDiffHash.slice(0, 8) || "(unknown)"}.`,
  };
}

/**
 * Create a new in_progress ReviewRun. Returns the run ID.
 *
 * `triggerReason` should describe what started the scan — "manual" for
 * the dashboard button, "prepush" for the git hook, "prcheck" for the
 * CLI/skill, "webhook" for inbound webhook-triggered scans.
 */
export async function createReviewRun(opts: {
  prId: string;
  repoId: string;
  commitHash: string;
  diffHash: string;
  reviewConfigHash: string;
  model?: string | null;
  triggerReason?: string;
  forced?: boolean;
  createdByUserId?: string | null;
}): Promise<string> {
  const id = `run-${randomUUID()}`;
  await prisma.reviewRun.create({
    data: {
      id,
      prId: opts.prId,
      repoId: opts.repoId,
      commitHash: opts.commitHash,
      diffHash: opts.diffHash,
      reviewConfigHash: opts.reviewConfigHash,
      status: "in_progress",
      startedAt: new Date(),
      completedAt: null,
      model: opts.model ?? null,
      rating: null,
      triggerReason: opts.triggerReason ?? "manual",
      forced: opts.forced ?? false,
      createdByUserId: opts.createdByUserId ?? null,
    },
  });
  return id;
}

/**
 * Concurrency guard — reject duplicate scans on the same PR.
 *
 * Returns the in-progress run if one exists and `force` is falsy, so the
 * caller can respond 409 without racing the live scan. `force=true`
 * overrides (used for re-scans after stuck runs).
 *
 * Note: this checks ReviewRun rows, not the in-memory `reviewLocks` map.
 * The locks guard the immediate critical section (status update + run
 * creation); this DB check catches races where two requests slip past the
 * lock in quick succession, or where a scan was started by a different
 * process entirely (separate Next.js worker, manual DB write, etc.).
 *
 * Phase 7: stale runs (older than SCAN_STALE_AFTER_MS) used to be auto-
 * reaped. Now they're inspected first — if a valid checkpoint exists,
 * return `kind: "stale_inspectable"` so the scan route can surface a
 * Continue / Start fresh affordance. Runs with no checkpoint still fall
 * through to the existing reap-and-proceed behavior.
 */
export async function assertNoActiveScan(
  prId: string,
  force: boolean,
  repoPath?: string | null,
): Promise<ActiveScanCheck> {
  if (force) return { ok: true };
  const inProgress = await prisma.reviewRun.findFirst({
    where: { prId, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      triggerReason: true,
      model: true,
      commitHash: true,
      diffHash: true,
      reviewConfigHash: true,
    },
  });
  if (!inProgress) return { ok: true };

  // Layer 2: stale-run inspection. If the in_progress run is older than
  // SCAN_STALE_AFTER_MS, the process that owned it is gone. Before reaping,
  // check whether a valid checkpoint exists — if so, surface it to the
  // scan route so the user can resume instead of losing the partial work.
  const ageMs = Date.now() - inProgress.startedAt.getTime();
  if (ageMs > SCAN_STALE_AFTER_MS) {
    const inspectable = repoPath
      ? await inspectStaleRun(repoPath, inProgress)
      : null;
    if (inspectable) {
      return {
        ok: false,
        kind: "stale_inspectable",
        runId: inProgress.id,
        startedAt: inProgress.startedAt,
        commitHash: inProgress.commitHash,
        diffHash: inProgress.diffHash,
        reviewConfigHash: inProgress.reviewConfigHash,
        checkpointId: inspectable.checkpointId,
        completedIterations: inspectable.completedIterations,
        totalIterations: inspectable.totalIterations,
        lastProvider: inspectable.lastProvider,
        lastModel: inspectable.lastModel,
      };
    }
    // No checkpoint — fall through to the existing reap-and-proceed path
    // so the user isn't blocked on an orphaned in_progress row.
    try {
      await prisma.reviewRun.update({
        where: { id: inProgress.id },
        data: { status: "failed", completedAt: new Date() },
      });
      console.warn(
        `[reviewFreshness] reaped stale in_progress run ${inProgress.id} ` +
          `(age=${Math.round(ageMs / 60_000)}min, prId=${prId}) — original ` +
          `trigger=${inProgress.triggerReason ?? "unknown"}, marked failed ` +
          `so the new scan can proceed.`,
      );
    } catch (err) {
      console.error(
        `[reviewFreshness] failed to reap stale run ${inProgress.id}:`,
        err,
      );
    }
    return { ok: true };
  }

  return {
    ok: false,
    runId: inProgress.id,
    startedAt: inProgress.startedAt,
    triggerReason: inProgress.triggerReason,
    model: inProgress.model,
  };
}

/**
 * Phase 7 — inspect a stale in_progress run for recoverable checkpoint
 * state. Returns null when no valid checkpoint is found (caller falls
 * through to reap). When checkpoints exist, prefers the run-level
 * `__run` checkpoint over per-chunk ones (chunked scans resume via the
 * large-PR orchestrator's retryFailedChunk, not the scan route).
 */
async function inspectStaleRun(
  repoPath: string,
  run: {
    id: string;
    commitHash: string;
    diffHash: string;
    reviewConfigHash: string;
  },
): Promise<{
  checkpointId: string;
  completedIterations: number;
  totalIterations: number;
  lastProvider: string | null;
  lastModel: string | null;
} | null> {
  // Lazy import — checkpointStore pulls in fs/node and we don't want to
  // pay that cost on every assertNoActiveScan call when no stale run exists.
  const { listRunCheckpoints, RUN_CHECKPOINT_ID } = await import("../services/checkpointStore");
  const checkpoints = await listRunCheckpoints(repoPath, run.id);
  if (checkpoints.length === 0) return null;
  // Prefer the run-level checkpoint for normal scans; if only chunk
  // checkpoints exist, return the first one (the UI can offer chunk-
  // specific resume via retryFailedChunk).
  const preferred =
    checkpoints.find((c) => c.checkpointId === RUN_CHECKPOINT_ID) ?? checkpoints[0];
  return {
    checkpointId: preferred.checkpointId,
    completedIterations: preferred.loopCount,
    totalIterations: preferred.maxIterations,
    lastProvider: preferred.provider,
    lastModel: preferred.model,
  };
}


export async function completeReviewRun(
  runId: string,
  result:
    | {
        status: "completed";
        rating: number | null;
        refused?: boolean;
        refusalNote?: string | null;
        // User-facing terminal classification, orthogonal to lifecycle
        // `status`. "reviewed" = model reviewed code (or empty-diff with
        // no prior cache). "skipped" = trivial-skip (diff was all config/
        // docs/generated, Tier 1+2 clean). Omitted/null on `failed` and
        // on legacy call sites that haven't been migrated.
        outcome?: "reviewed" | "skipped" | null;
      }
    | { status: "failed" },
): Promise<void> {
  try {
    await prisma.reviewRun.update({
      where: { id: runId },
      data: {
        status: result.status,
        completedAt: new Date(),
        ...(result.status === "completed"
          ? {
              rating: result.rating,
              outcome: result.outcome ?? null,
              // refused defaults to false on the column; only write when the
              // reviewer actually flagged. refusalNote written alongside.
              ...(result.refused === true
                ? { refused: true, refusalNote: result.refusalNote ?? null }
                : {}),
            }
          : {}),
      },
    });
  } catch (err) {
    console.warn(
      `[reviewFreshness] failed to mark run ${runId} as ${result.status}:`,
      err,
    );
  }
}

/**
 * Persist Phase 2 cost-telemetry payload to `ReviewRun.tokensUsed`.
 *
 * Best-effort: a write failure logs a warning but does not throw —
 * the scan's findings/rating are already persisted by the time this
 * is called, and a telemetry write failure must NOT mask a successful
 * review (or surface on a failed one).
 *
 * Caller passes the already-built `TokensUsed` JSON shape from
 * `reviewService.ts::buildTokensUsed()`; this helper is a thin
 * persistence wrapper so the write can be unit-tested in isolation.
 */
export async function setReviewRunTokens(
  runId: string,
  tokensUsed: unknown,
): Promise<void> {
  try {
    await prisma.reviewRun.update({
      where: { id: runId },
      data: { tokensUsed: tokensUsed as any },
    });
  } catch (err) {
    console.warn(
      `[reviewFreshness] failed to persist tokensUsed on run ${runId}:`,
      err,
    );
  }
}

/**
 * Phase 5 resume — stamp the ReviewRun with the time of its last
 * successful checkpoint write. Used by the resume UI to decide whether
 * a stale `in_progress` row has recoverable state. Best-effort: errors
 * are logged and swallowed so a checkpoint-metadata failure never
 * blocks the scan.
 */
export async function setReviewRunLastCheckpointAt(
  runId: string,
  at: Date,
): Promise<void> {
  try {
    await prisma.reviewRun.update({
      where: { id: runId },
      data: { lastCheckpointAt: at },
    });
  } catch (err) {
    console.warn(
      `[reviewFreshness] failed to persist lastCheckpointAt on run ${runId}:`,
      err,
    );
  }
}

/**
 * Phase 5 resume — per-chunk mirror of setReviewRunLastCheckpointAt.
 * Lets a chunked run resume just the interrupted chunk instead of
 * re-running every chunk from iteration 1.
 */
export async function setReviewChunkLastCheckpointAt(
  chunkId: string,
  at: Date,
): Promise<void> {
  try {
    await prisma.reviewChunk.update({
      where: { id: chunkId },
      data: { lastCheckpointAt: at },
    });
  } catch (err) {
    console.warn(
      `[reviewFreshness] failed to persist lastCheckpointAt on chunk ${chunkId}:`,
      err,
    );
  }
}

/**
 * Load the latest completed ReviewRun and its visible findings.
 *
 * This is the read-side single source of truth for "current report" style
 * endpoints. It deliberately filters verifier-rejected findings and computes
 * a lightweight stale flag against the currently persisted PrFile diffs.
 */
export async function getLatestCompletedReview(
  prId: string,
): Promise<LatestReviewResult> {
  const [latestRun, prRow] = await Promise.all([
    prisma.reviewRun.findFirst({
      where: { prId, status: "completed" },
      orderBy: { completedAt: "desc" },
      select: {
        id: true,
        commitHash: true,
        diffHash: true,
        reviewConfigHash: true,
        completedAt: true,
        rating: true,
        model: true,
        triggerReason: true,
        reliability: true,
        refused: true,
        refusalNote: true,
        outcome: true,
        status: true,
        chunksTotal: true,
        chunksCompleted: true,
        chunksFailed: true,
        chunksSkipped: true,
        tokensUsed: true,
      },
    }),
    prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { commitHash: true },
    }),
  ]);

  if (!latestRun) {
    return {
      reviewRun: null,
      findings: [],
      regressions: [],
      rejectedFindings: [],
      rejectedCount: 0,
      stale: false,
    };
  }

  const prFiles = await prisma.prFile.findMany({
    where: { prId },
    select: { filename: true, diff: true },
  });
  const currentDiffHash = computeDiffHash(prFiles, prRow?.commitHash ?? "");
  const stale = latestRun.diffHash !== "" && latestRun.diffHash !== currentDiffHash;

  const reviewFindingSelect = {
    id: true, prId: true, reviewRunId: true, repoId: true,
    category: true, severity: true, exploitability: true, impact: true,
    filename: true, line: true, explanation: true, diffSuggestion: true,
    evidenceChain: true, confidence: true, confidenceReason: true,
    verificationStatus: true, verificationNote: true, source: true, timestamp: true,
    isRegression: true, regressedFromRunId: true,
    skepticVerdict: true, skepticNote: true,
  } as const;

  const [findings, rejectedFindings, regressionRows] = await Promise.all([
    prisma.reviewFinding.findMany({
      where: {
        reviewRunId: latestRun.id,
        OR: [
          { verificationStatus: null },
          { verificationStatus: { not: "rejected" } },
        ],
        // Skeptic rejects mirror the verifier pattern: persisted for audit,
        // excluded from the active findings list.
        AND: [
          {
            OR: [
              { skepticVerdict: null },
              { skepticVerdict: { not: "rejected" } },
            ],
          },
        ],
        isRegression: false, // exclude regressions from main findings list
      },
      orderBy: { line: "asc" },
      select: reviewFindingSelect,
    }),
    prisma.reviewFinding.findMany({
      where: {
        reviewRunId: latestRun.id,
        OR: [
          { verificationStatus: "rejected" },
          { skepticVerdict: "rejected" },
        ],
      },
      orderBy: { line: "asc" },
      select: {
        id: true, filename: true, line: true, severity: true, category: true,
        explanation: true,
        verificationStatus: true, verificationNote: true,
        skepticVerdict: true, skepticNote: true,
        source: true,
      },
    }),
    prisma.reviewFinding.findMany({
      where: {
        reviewRunId: latestRun.id,
        isRegression: true,
      },
      orderBy: { line: "asc" },
      select: reviewFindingSelect,
    }),
  ]);

  return {
    reviewRun: latestRun,
    findings,
    regressions: regressionRows,
    rejectedFindings,
    rejectedCount: rejectedFindings.length,
    stale,
  };
}

/**
 * Load the currently in-progress ReviewRun for a PR, if any.
 *
 * Distinct from getLatestCompletedReview: that returns the most recent
 * COMPLETED run (for displaying findings). This returns the in_progress
 * run so the UI can render live chunk progress, poll iteration logs, and
 * surface "scanning commit X" while the agentic loop is still running.
 *
 * Stale-run reaping is handled upstream by assertNoActiveScan on the next
 * scan trigger (and by runReaper on cold start), so this just reads what
 * the DB says — no age-based filtering here.
 *
 * Also loads partial findings (already persisted from completed chunks)
 * and per-chunk iteration counts parsed from ReviewLog. Both let the UI
 * tell the user "here's what we've found so far" and "we're on round N"
 * while the scan is still running — instead of just a spinner.
 */
export async function getActiveScan(prId: string): Promise<{
  reviewRun: {
    id: string;
    prId: string;
    commitHash: string;
    diffHash: string;
    startedAt: Date;
    triggerReason: string | null;
    model: string | null;
    chunksTotal: number;
    chunksCompleted: number;
    chunksFailed: number;
    chunksSkipped: number;
  } | null;
  findings: Array<{
    id: string;
    prId: string;
    reviewRunId: string | null;
    repoId: string;
    category: string;
    severity: string;
    filename: string;
    line: number | null;
    explanation: string;
    diffSuggestion: string | null;
    evidenceChain: string | null;
    confidence: number | null;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
    timestamp: string;
    reviewChunkId: string | null;
  }>;
  /**
   * Max iteration number seen per chunkId. Chunked scans key this by the
   * chunk's DB id; non-chunked scans key it under "__run" (the sentinel
   * used when ReviewLog.reviewChunkId is null). Value shape:
   * { current: N, max: M, provider?: string } where M comes from the
   * "Iteration N/M — Provider" log format written by reviewService.ts.
   * Provider is the chat preset that wrote the line — lets the UI
   * distinguish "8/8 on NVIDIA" from "8/8 on Minimax-fallback" when
   * chunks in a single scan use different chain entries.
   */
  iterationsByChunk: Record<string, { current: number; max: number; provider?: string }>;
}> {
  const reviewRun = await prisma.reviewRun.findFirst({
    where: { prId, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      prId: true,
      commitHash: true,
      diffHash: true,
      startedAt: true,
      triggerReason: true,
      model: true,
      chunksTotal: true,
      chunksCompleted: true,
      chunksFailed: true,
      chunksSkipped: true,
    },
  });

  if (!reviewRun) {
    return { reviewRun: null, findings: [], iterationsByChunk: {} };
  }

  const [findings, logs] = await Promise.all([
    prisma.reviewFinding.findMany({
      where: {
        reviewRunId: reviewRun.id,
        OR: [
          { verificationStatus: null },
          { verificationStatus: { not: "rejected" } },
        ],
        // Skeptic rejects mirror the verifier pattern: persisted for audit,
        // excluded from the active findings list.
        AND: [
          {
            OR: [
              { skepticVerdict: null },
              { skepticVerdict: { not: "rejected" } },
            ],
          },
        ],
      },
      orderBy: { line: "asc" },
      select: {
        id: true,
        prId: true,
        reviewRunId: true,
        reviewChunkId: true,
        repoId: true,
        category: true,
        severity: true,
        exploitability: true,
        impact: true,
        filename: true,
        line: true,
        explanation: true,
        diffSuggestion: true,
        evidenceChain: true,
        confidence: true,
        verificationStatus: true,
        verificationNote: true,
        skepticVerdict: true,
        skepticNote: true,
        source: true,
        timestamp: true,
      },
    }),
    prisma.reviewLog.findMany({
      where: { reviewRunId: reviewRun.id },
      select: { message: true, reviewChunkId: true },
    }),
  ]);

  return {
    reviewRun,
    findings,
    iterationsByChunk: parseIterationLogs(logs),
  };
}

/**
 * Parse "Iteration N/M — Provider" log messages into a per-chunk map of
 * the highest iteration number seen. ReviewService writes one such line
 * per agentic-loop iteration, so the max N is the current round for
 * that chunk. The provider name (chat preset that wrote the line) is
 * captured so the UI can show which model each chunk is running on —
 * critical when chunks in one scan use different chain entries with
 * different maxIterations caps. Logs without a chunkId fall under the
 * "__run" sentinel key (used by non-chunked scans).
 */
export function parseIterationLogs(
  logs: Array<{ message: string; reviewChunkId: string | null }>,
): Record<string, { current: number; max: number; provider?: string }> {
  // Current format: "Iteration N/M — Provider" (em-dash separator).
  const ITER_RE_WITH_PROVIDER = /^Iteration (\d+)\/(\d+)\s+—\s+(.+)$/;
  // Legacy format: "Iteration N/M" (pre-provider logs, kept for back-compat).
  const ITER_RE_LEGACY = /^Iteration (\d+)\/(\d+)\b/;
  const out: Record<string, { current: number; max: number; provider?: string }> = {};
  for (const log of logs) {
    const withProvider = log.message.match(ITER_RE_WITH_PROVIDER);
    const legacy = !withProvider ? log.message.match(ITER_RE_LEGACY) : null;
    const match = withProvider ?? legacy;
    if (!match || !match[1] || !match[2]) continue;
    const current = Number.parseInt(match[1], 10);
    const max = Number.parseInt(match[2], 10);
    if (!Number.isFinite(current) || !Number.isFinite(max)) continue;
    const provider = withProvider ? withProvider[3]?.trim() : undefined;
    const key = log.reviewChunkId ?? "__run";
    out[key] = { current, max, provider };
  }
  return out;
}

export type { RatingTrendEntry } from "./stabilityScore";


/**
 * Recent completed runs for a PR, ascending order (oldest first, current last).
 * Drives the rating-trend rendering in `/dragnet status`: R1: 3/10 → R2: 5/10 → R3: 7/10.
 * Each entry includes `newFindingsCount` — the number of findings whose
 * `firstSeenRunId` matches this run (i.e. new issues introduced that round).
 */
export async function getRecentRuns(
  prId: string,
  limit = 5,
): Promise<RatingTrendEntry[]> {
  const runs = await prisma.reviewRun.findMany({
    where: { prId, status: "completed" },
    orderBy: { completedAt: "desc" },
    take: limit,
    select: { id: true, rating: true, completedAt: true, commitHash: true, model: true },
  });

  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const newCounts = await prisma.reviewFinding.groupBy({
    by: ["firstSeenRunId"],
    where: { prId, firstSeenRunId: { in: runIds } },
    _count: true,
  });
  const countMap = new Map(newCounts.map((g) => [g.firstSeenRunId, g._count]));

  return runs
    .reverse()
    .map((r) => ({
      runId: r.id,
      rating: r.rating,
      completedAt: r.completedAt,
      commitHash: r.commitHash,
      model: r.model,
      newFindingsCount: countMap.get(r.id) ?? 0,
    }));
}
