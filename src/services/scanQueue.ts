import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import { readLimits } from "@/src/lib/prSizeConfig";

export type ScanJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  repository?: { name: string } | null;
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

function isManualTrigger(triggerReason: string | undefined): boolean {
  return !triggerReason || triggerReason === "manual" || triggerReason.startsWith("manual-");
}

function queuePriority(job: { priority?: number; forced?: boolean; triggerReason?: string }): number {
  return job.priority ?? (job.forced || isManualTrigger(job.triggerReason) ? 10 : 0);
}

async function positionFor(job: { id?: string; state: string; priority?: number; createdAt?: Date }): Promise<number | null> {
  if (job.state !== "queued" || !job.createdAt || !job.id) return null;
  await normalizeManualPriorities();
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

async function normalizeManualPriorities(): Promise<void> {
  await prisma.scanJob.updateMany({
    where: {
      state: "queued",
      priority: 0,
      OR: [{ triggerReason: "manual" }, { triggerReason: { startsWith: "manual-" } }],
    },
    data: { priority: 10 },
  });
}

/** Atomically creates the queue identity and coalesces the same PR revision. */
export async function admitScanJob(input: {
  prId: string;
  repoId: string;
  commitHash: string;
  triggerReason?: string;
  forced?: boolean;
  resumeRequested?: boolean;
  freshRequested?: boolean;
  createdByUserId?: string | null;
}): Promise<QueueJobView> {
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
      priority: input.forced || isManualTrigger(input.triggerReason) ? 10 : 0,
    },
    update: {},
  });
  // A force/recovery request is allowed to reuse the durable identity while
  // moving a terminal job back through the queue. Ordinary duplicate
  // requests remain idempotent and never restart completed work.
  if ((input.forced || input.resumeRequested || input.freshRequested)
    && ["completed", "failed", "interrupted", "cancelled"].includes(job.state)) {
    const requeued = await prisma.scanJob.update({
      where: { id: job.id },
      data: {
        state: "queued",
        forced: input.forced ?? job.forced,
        resumeRequested: input.resumeRequested ?? job.resumeRequested,
        freshRequested: input.freshRequested ?? job.freshRequested,
        triggerReason: input.triggerReason ?? job.triggerReason,
        completedAt: null,
        errorMessage: null,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
    return view(requeued, await positionFor(requeued), requeued.forced, requeued.resumeRequested, requeued.freshRequested);
  }
  return view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested);
}

/** Admit a scan using the PR's current revision as the coalescing key. */
export async function admitScanJobForPr(input: {
  prId: string;
  triggerReason: string;
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
        OR: [{ triggerReason: "manual" }, { triggerReason: { startsWith: "manual-" } }],
      },
      data: { priority: 10 },
    });
    const active = await tx.scanJob.count({
      where: { state: "running", leaseExpiresAt: { gt: now } },
    });
    if (active >= maxConcurrent) return null;

    const next = await tx.scanJob.findFirst({
      where: { state: "queued" },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    if (!next) return null;
    const claimed = await tx.scanJob.updateMany({
      where: { id: next.id, state: "queued" },
      data: { state: "running", workerId, claimedAt: now, leaseExpiresAt },
    });
    if (claimed.count !== 1) return null;
    return view({ ...next, state: "running", claimedAt: now, leaseExpiresAt }, null, next.forced, next.resumeRequested, next.freshRequested);
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
    data: { state: "queued", workerId: null, claimedAt: null, leaseExpiresAt: null },
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
  const job = await prisma.scanJob.findFirst({
    where: { prId, state: { in: ["queued", "running"] } },
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
  await normalizeManualPriorities();
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

export type ScanQueueExecutor = (job: QueueJobView) => Promise<{
  state?: "completed" | "failed" | "cancelled" | "interrupted";
  reviewRunId?: string | null;
  errorMessage?: string | null;
}>;

/** Starts the durable worker loop used by the Node runtime. */
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
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void recoverExpiredScanJobs()
    .then((count) => {
      if (count > 0) console.log(`[scan-queue] recovered ${count} expired lease(s)`);
    })
    .catch((error) => console.warn("[scan-queue] startup lease recovery failed:", error));
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
