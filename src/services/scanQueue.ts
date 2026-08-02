import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import { readLimits } from "@/src/lib/prSizeConfig";
import { isAutoRescanEnabledForRepo } from "@/src/lib/autoRescanPolicy";

export type ScanJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Explicit = user/agent requested; AFK = background auto-rescan path. */
export type ScanAdmitKind = "explicit" | "afk";

export type QueueJobView = {
  jobId: string;
  prId: string;
  commitHash: string;
  state: ScanJobState;
  queuePosition: number | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  forced: boolean;
  resumeRequested: boolean;
  freshRequested: boolean;
  priority: number;
  triggerReason: string;
  repositoryName: string | null;
  prTitle: string | null;
  sourceBranch: string | null;
  createdAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
};

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const AFK_TRIGGER_REASONS = new Set(["webhook", "auto", "polling"]);
const TERMINAL_STATES = new Set(["completed", "failed", "interrupted", "cancelled"]);

/**
 * Wake hooks for the durable scan-queue worker.
 *
 * Admit only enqueues; the worker claims when a global/per-repo slot is free.
 * Calling notify after a job becomes `queued` starts that claim immediately
 * (instead of waiting up to the poll interval). Independent of auto-rescan:
 * any admitted job (explicit prcheck/implement or AFK) drains the same way.
 */
type ScanQueueWakeListener = () => void;
const scanQueueWakeListeners = new Set<ScanQueueWakeListener>();

/** Register a wake listener; returns unsubscribe. Used by startScanQueueWorker. */
export function registerScanQueueWakeListener(listener: ScanQueueWakeListener): () => void {
  scanQueueWakeListeners.add(listener);
  return () => {
    scanQueueWakeListeners.delete(listener);
  };
}

/** Nudge workers to claim if a concurrent slot is available. Safe no-op if none registered. */
export function notifyScanQueueWake(): void {
  for (const listener of scanQueueWakeListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[scan-queue] wake listener failed:", error);
    }
  }
}

function wakeIfQueued(state: string): void {
  if (state === "queued") notifyScanQueueWake();
}

/** Resolve admit kind from an optional override or the trigger reason. */
export function resolveAdmitKind(
  triggerReason?: string,
  kind?: ScanAdmitKind,
): ScanAdmitKind {
  if (kind) return kind;
  if (triggerReason && AFK_TRIGGER_REASONS.has(triggerReason)) return "afk";
  return "explicit";
}

function view(job: {
  id: string;
  prId: string;
  commitHash: string;
  state: string;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  forced: boolean;
  resumeRequested: boolean;
  freshRequested: boolean;
  priority?: number;
  triggerReason?: string;
  repository?: { name?: string; maxConcurrentScans?: number | null } | null;
  pullRequest?: { title: string; sourceBranch: string } | null;
  createdAt: Date;
  completedAt?: Date | null;
  errorMessage?: string | null;
}, queuePosition: number | null, forced: boolean, resumeRequested: boolean, freshRequested: boolean): QueueJobView {
  return {
    jobId: job.id,
    prId: job.prId,
    commitHash: job.commitHash,
    state: job.state as ScanJobState,
    queuePosition,
    claimedAt: job.claimedAt,
    leaseExpiresAt: job.leaseExpiresAt,
    forced,
    resumeRequested,
    freshRequested,
    priority: job.priority ?? 0,
    triggerReason: job.triggerReason ?? "manual",
    repositoryName: job.repository?.name ?? null,
    prTitle: job.pullRequest?.title ?? null,
    sourceBranch: job.pullRequest?.sourceBranch ?? null,
    createdAt: job.createdAt,
    completedAt: job.completedAt ?? null,
    errorMessage: job.errorMessage ?? null,
  };
}

function isExplicitPriorityTrigger(triggerReason: string | undefined): boolean {
  return resolveAdmitKind(triggerReason) === "explicit";
}

function queuePriority(job: { priority?: number; forced?: boolean; triggerReason?: string }): number {
  return job.priority ?? (job.forced || isExplicitPriorityTrigger(job.triggerReason) ? 10 : 0);
}

async function positionFor(job: { id?: string; state: string; priority?: number; createdAt?: Date }): Promise<number | null> {
  if (job.state !== "queued" || !job.createdAt || !job.id) return null;
  await normalizeExplicitPriorities();
  const priority = job.priority ?? 0;
  return (await prisma.scanJob.count({
    where: {
      state: "queued",
      OR: [
        { priority: { gt: priority } },
        { priority, createdAt: { lt: job.createdAt } },
        { priority, createdAt: job.createdAt, id: { lt: job.id } },
      ],
    },
  })) + 1;
}

async function normalizeExplicitPriorities(): Promise<void> {
  await prisma.scanJob.updateMany({
    where: {
      state: "queued",
      priority: 0,
      OR: [
        { triggerReason: "manual" },
        { triggerReason: { startsWith: "manual-" } },
        { triggerReason: "prcheck" },
        { triggerReason: "prepush" },
        { triggerReason: "hosted" },
      ],
    },
    data: { priority: 10 },
  });
}

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** Clear in-memory lock + active DB run so a forced re-admit can start clean. */
async function clearInFlightForForce(prId: string): Promise<void> {
  const { abortScan } = await import("@/src/lib/reviewLocks");
  abortScan(prId);
  const activeRun = await prisma.reviewRun.findFirst({
    where: { prId, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (activeRun) {
    await prisma.reviewRun.update({
      where: { id: activeRun.id },
      data: { status: "failed", completedAt: new Date() },
    });
  }
  await prisma.pullRequest.updateMany({
    where: { id: prId },
    data: { status: "In Progress" },
  });
}

/** Atomically creates the queue identity and coalesces the same PR revision. */
export async function admitScanJob(input: {
  prId: string;
  repoId: string;
  commitHash: string;
  triggerReason?: string;
  /** explicit always queues; afk never requeues terminal work. */
  kind?: ScanAdmitKind;
  forced?: boolean;
  resumeRequested?: boolean;
  freshRequested?: boolean;
  createdByUserId?: string | null;
}): Promise<QueueJobView> {
  const kind = resolveAdmitKind(input.triggerReason, input.kind);
  const explicit = kind === "explicit";
  const job = await prisma.scanJob.upsert({
    where: { prId_commitHash: { prId: input.prId, commitHash: input.commitHash } },
    create: {
      id: randomUUID(),
      prId: input.prId,
      repoId: input.repoId,
      commitHash: input.commitHash,
      triggerReason: input.triggerReason ?? "manual",
      forced: input.forced ?? false,
      resumeRequested: input.resumeRequested ?? false,
      freshRequested: input.freshRequested ?? false,
      priority: input.forced || explicit ? 10 : 0,
    },
    update: {},
  });
  // Force recovery: clear locks, mark forced (worker passes ?force=true →
  // cache bypass), and re-admit. Covers terminal, running, and queued jobs
  // so null/stuck/completed runs are always recoverable.
  if (input.forced) {
    if (job.state === "running") {
      await clearInFlightForForce(input.prId);
    }
    if (
      job.state === "running" ||
      TERMINAL_STATES.has(job.state) ||
      job.state === "queued"
    ) {
      const requeued = await prisma.scanJob.update({
        where: { id: job.id },
        data: {
          state: "queued",
          forced: true,
          resumeRequested: input.resumeRequested ?? false,
          freshRequested: input.freshRequested ?? false,
          triggerReason: input.triggerReason ?? job.triggerReason,
          priority: 10,
          completedAt: null,
          errorMessage: null,
          workerId: null,
          claimedAt: null,
          leaseExpiresAt: null,
        },
      });
      wakeIfQueued(requeued.state);
      return view(
        requeued,
        await positionFor(requeued),
        requeued.forced,
        requeued.resumeRequested,
        requeued.freshRequested,
      );
    }
  }

  // Explicit review (and resume/fresh) may reuse the durable identity
  // while moving a terminal job back onto the queue. AFK duplicates stay
  // idempotent and never restart completed work for the same revision.
  // In-flight (queued/running) re-requests always return the active job.
  const mayRequeueTerminal =
    explicit || input.resumeRequested || input.freshRequested;
  if (mayRequeueTerminal && TERMINAL_STATES.has(job.state)) {
    const requeued = await prisma.scanJob.update({
      where: { id: job.id },
      data: {
        state: "queued",
        forced: input.forced ?? job.forced,
        resumeRequested: input.resumeRequested ?? job.resumeRequested,
        freshRequested: input.freshRequested ?? job.freshRequested,
        triggerReason: input.triggerReason ?? job.triggerReason,
        priority: input.forced || explicit ? 10 : job.priority,
        completedAt: null,
        errorMessage: null,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
    wakeIfQueued(requeued.state);
    return view(requeued, await positionFor(requeued), requeued.forced, requeued.resumeRequested, requeued.freshRequested);
  }
  wakeIfQueued(job.state);
  return view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested);
}

/** Admit a scan using the PR's current revision as the coalescing key. */
export async function admitScanJobForPr(input: {
  prId: string;
  triggerReason: string;
  kind?: ScanAdmitKind;
  forced?: boolean;
  resumeRequested?: boolean;
  freshRequested?: boolean;
  createdByUserId?: string | null;
}): Promise<QueueJobView | null> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: input.prId },
    select: { repoId: true, commitHash: true },
  });
  if (!pr) return null;
  return admitScanJob({ ...input, repoId: pr.repoId, commitHash: pr.commitHash });
}

/**
 * Background AFK admit. Auto-rescan disabled → null (no queue work).
 * Does not requeue terminal jobs for the same revision.
 */
export async function admitAfkScanJob(input: {
  prId: string;
  repoId: string;
  commitHash: string;
  triggerReason: string;
}): Promise<QueueJobView | null> {
  if (!(await isAutoRescanEnabledForRepo(input.repoId))) return null;
  return admitScanJob({
    prId: input.prId,
    repoId: input.repoId,
    commitHash: input.commitHash,
    triggerReason: input.triggerReason,
    kind: "afk",
  });
}

/** AFK admit using the PR's current revision; null when policy disables auto-rescan. */
export async function admitAfkScanJobForPr(input: {
  prId: string;
  triggerReason: string;
}): Promise<QueueJobView | null> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: input.prId },
    select: { repoId: true, commitHash: true },
  });
  if (!pr) return null;
  return admitAfkScanJob({
    prId: input.prId,
    repoId: pr.repoId,
    commitHash: pr.commitHash,
    triggerReason: input.triggerReason,
  });
}

/**
 * Claims one queued job using a DB transaction. Expired leases are returned to
 * the queue first, so a restarted worker can recover durable work.
 */
export async function claimNextScanJob(options?: {
  workerId?: string;
  maxConcurrentScans?: number;
  leaseMs?: number;
  now?: Date;
}): Promise<QueueJobView | null> {
  const workerId = options?.workerId ?? `worker-${randomUUID()}`;
  const now = options?.now ?? new Date();
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  const maxConcurrent = Math.max(1, Math.floor(options?.maxConcurrentScans ?? readLimits().maxConcurrentScans));
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return prisma.$transaction(async (tx) => {
    if (typeof (tx as typeof tx & { $executeRaw?: unknown }).$executeRaw === "function") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dragnet:scan-queue'))`;
    }
    await tx.scanJob.updateMany({
      where: { state: "running", leaseExpiresAt: { lt: now } },
      data: { state: "queued", workerId: null, claimedAt: null, leaseExpiresAt: null },
    });
    await tx.scanJob.updateMany({
      where: {
        state: "queued",
        priority: 0,
        OR: [
          { triggerReason: "manual" },
          { triggerReason: { startsWith: "manual-" } },
          { triggerReason: "prcheck" },
          { triggerReason: "prepush" },
          { triggerReason: "hosted" },
        ],
      },
      data: { priority: 10 },
    });
    const active = await tx.scanJob.count({
      where: { state: "running", leaseExpiresAt: { gt: now } },
    });
    if (active >= maxConcurrent) return null;

    const excludedJobIds: string[] = [];
    while (true) {
      const next = await tx.scanJob.findFirst({
        where: {
          state: "queued",
          ...(excludedJobIds.length > 0 ? { id: { notIn: excludedJobIds } } : {}),
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        include: { repository: { select: { name: true, maxConcurrentScans: true } } },
      });
      if (!next) return null;

      const repoLimit = next.repository?.maxConcurrentScans;
      if (repoLimit != null) {
        const effectiveRepoLimit = Math.min(maxConcurrent, Math.max(1, Math.floor(repoLimit)));
        const activeInRepo = await tx.scanJob.count({
          where: { repoId: next.repoId, state: "running", leaseExpiresAt: { gt: now } },
        });
        if (activeInRepo >= effectiveRepoLimit) {
          excludedJobIds.push(next.id);
          continue;
        }
      }

      const claimed = await tx.scanJob.updateMany({
        where: { id: next.id, state: "queued" },
        data: { state: "running", workerId, claimedAt: now, leaseExpiresAt },
      });
      if (claimed.count !== 1) return null;
      return view({ ...next, state: "running", claimedAt: now, leaseExpiresAt }, null, next.forced, next.resumeRequested, next.freshRequested);
    }
  });
}

export async function renewScanJobLease(jobId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const result = await prisma.scanJob.updateMany({
    where: { id: jobId, state: "running", workerId },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return result.count === 1;
}

/** Requeue running jobs whose worker lease expired before a restart. */
export async function recoverExpiredScanJobs(now = new Date()): Promise<number> {
  const result = await prisma.scanJob.updateMany({
    where: { state: "running", leaseExpiresAt: { lt: now } },
    data: {
      state: "queued",
      workerId: null,
      claimedAt: null,
      leaseExpiresAt: null,
      resumeRequested: true,
    },
  });
  return result.count;
}

export async function releaseScanJob(input: {
  jobId: string;
  workerId: string;
  state: Exclude<ScanJobState, "queued" | "running">;
  reviewRunId?: string | null;
  errorMessage?: string | null;
}): Promise<boolean> {
  const result = await prisma.scanJob.updateMany({
    where: { id: input.jobId, state: "running", workerId: input.workerId },
    data: {
      state: input.state,
      workerId: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      reviewRunId: input.reviewRunId ?? undefined,
      errorMessage: input.errorMessage ?? undefined,
    },
  });
  return result.count === 1;
}

export async function getScanJobForPr(prId: string): Promise<QueueJobView | null> {
  if (typeof (prisma as typeof prisma & { scanJob?: unknown }).scanJob === "undefined") return null;
  // Requeue expired running leases so a dead worker cannot pin the PR as
  // "scanning" forever in the findings payload / isScanning gate.
  await recoverExpiredScanJobs();
  const job = await prisma.scanJob.findFirst({
    where: { prId, state: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
    include: { repository: { select: { name: true } }, pullRequest: { select: { title: true, sourceBranch: true } } },
  });
  if (!job) return null;
  // Belt-and-suspenders: never surface a running job whose lease already
  // expired (requeue race or clock skew). Treat as not active for UI.
  if (
    job.state === "running" &&
    job.leaseExpiresAt &&
    job.leaseExpiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested);
}

/** Most recent job for a PR (any state) — used to surface terminal gate failures. */
export async function getLatestScanJobForPr(prId: string): Promise<QueueJobView | null> {
  if (typeof (prisma as typeof prisma & { scanJob?: unknown }).scanJob === "undefined") return null;
  const job = await prisma.scanJob.findFirst({
    where: { prId },
    orderBy: { createdAt: "desc" },
    include: { repository: { select: { name: true } }, pullRequest: { select: { title: true, sourceBranch: true } } },
  });
  return job ? view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested) : null;
}

/** Wait for a queued job when the caller has a synchronous contract (pre-push). */
export async function waitForScanJob(jobId: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<{
  state: ScanJobState;
  reviewRunId: string | null;
  errorMessage: string | null;
} | null> {
  const deadline = Date.now() + (options?.timeoutMs ?? 5 * 60 * 1000);
  const pollMs = options?.pollMs ?? 250;
  while (Date.now() < deadline) {
    const job = await prisma.scanJob.findUnique({
      where: { id: jobId },
      select: { state: true, reviewRunId: true, errorMessage: true },
    });
    if (!job) return null;
    if (!["queued", "running"].includes(job.state)) {
      return { state: job.state as ScanJobState, reviewRunId: job.reviewRunId, errorMessage: job.errorMessage };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export async function cancelScanJob(prId: string): Promise<boolean> {
  const job = await prisma.scanJob.findFirst({ where: { prId, state: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } });
  return job ? cancelScanJobById(job.id) : false;
}

export async function cancelScanJobById(jobId: string): Promise<boolean> {
  const job = await prisma.scanJob.findUnique({ where: { id: jobId }, select: { prId: true, state: true } });
  if (!job || !["queued", "running"].includes(job.state)) return false;
  if (job.state === "running") {
    const { abortScan } = await import("@/src/lib/reviewLocks");
    abortScan(job.prId);
    const activeRun = await prisma.reviewRun.findFirst({
      where: { prId: job.prId, status: "in_progress" },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (activeRun) {
      await prisma.reviewRun.update({
        where: { id: activeRun.id },
        data: { status: "failed", completedAt: new Date() },
      });
    }
    await prisma.pullRequest.updateMany({ where: { id: job.prId }, data: { status: "Pending" } });
  }
  const result = await prisma.scanJob.updateMany({
    where: { id: jobId, state: { in: ["queued", "running"] } },
    data: { state: "cancelled", workerId: null, leaseExpiresAt: null, completedAt: new Date() },
  });
  return result.count > 0;
}

export async function retryFailedScanJob(jobId: string): Promise<QueueJobView | null> {
  const result = await prisma.scanJob.updateMany({
    where: { id: jobId, state: "failed" },
    data: { state: "queued", workerId: null, claimedAt: null, leaseExpiresAt: null, completedAt: null, errorMessage: null },
  });
  if (result.count !== 1) return null;
  const job = await prisma.scanJob.findUnique({
    where: { id: jobId },
    include: { repository: { select: { name: true } }, pullRequest: { select: { title: true, sourceBranch: true } } },
  });
  return job ? view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested) : null;
}

export async function prioritizeScanJob(jobId: string): Promise<boolean> {
  const result = await prisma.scanJob.updateMany({ where: { id: jobId, state: "queued" }, data: { priority: 100 } });
  return result.count === 1;
}

export async function listScanJobs(): Promise<QueueJobView[]> {
  await normalizeExplicitPriorities();
  const jobs = await prisma.scanJob.findMany({
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    include: { repository: { select: { name: true } }, pullRequest: { select: { title: true, sourceBranch: true } } },
  });
  const queued = jobs.filter((job) => job.state === "queued").sort((a, b) =>
    queuePriority(b) - queuePriority(a) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id),
  );
  const positions = new Map(queued.map((job, index) => [job.id, index + 1]));
  return jobs.map((job) => view(job, positions.get(job.id) ?? null, job.forced, job.resumeRequested, job.freshRequested));
}

/** Map a scan-route HTTP response into the durable queue release state. */
export function classifyQueueWorkerHttpResult(
  resOk: boolean,
  body: Record<string, unknown>,
  httpStatus?: number,
): {
  state: "completed" | "failed" | "interrupted";
  reviewRunId: string | null;
  errorMessage?: string | null;
} {
  const reviewRunId = typeof body.runId === "string" ? body.runId : null;
  if (!resOk) {
    return {
      state: "failed",
      reviewRunId,
      errorMessage:
        typeof body.message === "string"
          ? body.message
          : typeof body.error === "string"
            ? body.error
            : httpStatus != null
              ? `scan route returned ${httpStatus}`
              : "scan route failed",
    };
  }
  if (body.interrupted === true) {
    return { state: "interrupted", reviewRunId };
  }
  const terminal = body.terminalOutcome;
  const terminalFailed =
    body.success === false ||
    (terminal != null &&
      typeof terminal === "object" &&
      (terminal as { isFailed?: unknown }).isFailed === true);
  if (terminalFailed) {
    const reason =
      typeof body.systemWarn === "string"
        ? body.systemWarn
        : terminal != null &&
            typeof terminal === "object" &&
            typeof (terminal as { reason?: unknown }).reason === "string"
          ? String((terminal as { reason: string }).reason)
          : "Scan failed without an earned AI pass.";
    return { state: "failed", reviewRunId, errorMessage: reason };
  }
  return { state: "completed", reviewRunId };
}

export type ScanQueueExecutor = (job: QueueJobView) => Promise<{
  state?: "completed" | "failed" | "cancelled" | "interrupted";
  reviewRunId?: string | null;
  errorMessage?: string | null;
}>;

/**
 * Starts the durable worker loop used by the Node runtime.
 *
 * Auto-start contract (independent of auto-rescan):
 * - Any job in `queued` is eligible when a global (and per-repo) slot is free.
 * - tick runs on an interval, after each job finishes, on wake-after-admit,
 *   and after expired-lease recovery.
 * Auto-rescan only controls whether AFK/webhook/poll *admits* jobs; once
 * admitted (including explicit implement/prcheck), this worker starts them.
 */
export function startScanQueueWorker(options: {
  execute: ScanQueueExecutor;
  intervalMs?: number;
  workerId?: string;
}): () => void {
  const workerId = options.workerId ?? `scan-worker-${randomUUID()}`;
  const intervalMs = options.intervalMs ?? 1000;
  let stopped = false;
  let ticking = false;
  let active = 0;
  const executeJob = async (job: QueueJobView) => {
    const heartbeat = setInterval(() => {
      void renewScanJobLease(job.jobId, workerId).catch((error) =>
        console.warn("[scan-queue] lease renewal failed:", error),
      );
    }, Math.floor(DEFAULT_LEASE_MS / 3));
    heartbeat.unref?.();
    try {
      const result = await options.execute(job);
      await releaseScanJob({
        jobId: job.jobId,
        workerId,
        state: result.state ?? "completed",
        reviewRunId: result.reviewRunId,
        errorMessage: result.errorMessage,
      });
    } catch (error) {
      await releaseScanJob({
        jobId: job.jobId,
        workerId,
        state: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(heartbeat);
      active -= 1;
      // Slot freed → claim the next queued PR immediately.
      void tick();
    }
  };
  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const maxConcurrent = Math.max(1, Math.floor(readLimits().maxConcurrentScans));
      while (!stopped && active < maxConcurrent) {
        const job = await claimNextScanJob({ workerId, maxConcurrentScans: maxConcurrent });
        if (!job) break;
        active += 1;
        void executeJob(job);
      }
    } catch (error) {
      console.warn("[scan-queue] worker tick failed:", error);
    } finally {
      ticking = false;
    }
  };
  const unsubWake = registerScanQueueWakeListener(() => {
    if (!stopped) void tick();
  });
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void recoverExpiredScanJobs()
    .then((count) => {
      if (count > 0) {
        console.log(`[scan-queue] recovered ${count} expired lease(s)`);
        notifyScanQueueWake();
      }
    })
    .catch((error) => console.warn("[scan-queue] startup lease recovery failed:", error));
  void tick();
  return () => {
    stopped = true;
    unsubWake();
    clearInterval(timer);
  };
}
