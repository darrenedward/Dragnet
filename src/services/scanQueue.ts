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
  };
}

async function positionFor(job: { state: string; createdAt?: Date }): Promise<number | null> {
  if (job.state !== "queued" || !job.createdAt) return null;
  return (await prisma.scanJob.count({
    where: {
      state: "queued",
      OR: [
        { createdAt: { lt: job.createdAt } },
        { createdAt: job.createdAt, id: { lt: (job as { id?: string }).id ?? "" } },
      ],
    },
  })) + 1;
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
    },
    update: {},
  });
  return view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested);
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
    const active = await tx.scanJob.count({
      where: { state: "running", leaseExpiresAt: { gt: now } },
    });
    if (active >= maxConcurrent) return null;

    const next = await tx.scanJob.findFirst({
      where: { state: "queued" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  });
  return job ? view(job, await positionFor(job), job.forced, job.resumeRequested, job.freshRequested) : null;
}

export async function cancelScanJob(prId: string): Promise<boolean> {
  const result = await prisma.scanJob.updateMany({
    where: { prId, state: { in: ["queued", "running"] } },
    data: { state: "cancelled", workerId: null, leaseExpiresAt: null, completedAt: new Date() },
  });
  return result.count > 0;
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
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const job = await claimNextScanJob({ workerId });
      if (!job) return;
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
      }
    } catch (error) {
      console.warn("[scan-queue] worker tick failed:", error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
