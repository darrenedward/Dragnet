import { beforeEach, describe, expect, it, vi } from "vitest";

const scanJob = {
  upsert: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};
const reviewRun = { findFirst: vi.fn(), update: vi.fn() };
const pullRequest = { updateMany: vi.fn() };
const prismaMock = {
  scanJob,
  reviewRun,
  pullRequest,
  $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock)),
};

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/prSizeConfig", () => ({ readLimits: () => ({ maxConcurrentScans: 1 }) }));
const abortScan = vi.fn();
vi.mock("@/src/lib/reviewLocks", () => ({ abortScan }));

describe("scan queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admits one durable job and returns its queue position", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    scanJob.upsert.mockResolvedValue({
      id: "job-1", prId: "pr-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt,
    });
    scanJob.count.mockResolvedValue(2);
    const { admitScanJob } = await import("@/src/services/scanQueue");

    await expect(admitScanJob({ prId: "pr-1", repoId: "repo-1", commitHash: "abc" })).resolves.toMatchObject({
      jobId: "job-1", state: "queued", queuePosition: 3,
    });
    expect(scanJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { prId_commitHash: { prId: "pr-1", commitHash: "abc" } },
      update: {},
    }));
  });

  it("wakes the queue worker when a job is admitted as queued (slot auto-start)", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    scanJob.upsert.mockResolvedValue({
      id: "job-wake", prId: "pr-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt, forced: false,
      resumeRequested: false, freshRequested: false, priority: 10, triggerReason: "prcheck",
    });
    scanJob.count.mockResolvedValue(0);
    const wake = vi.fn();
    const { admitScanJob, registerScanQueueWakeListener } = await import("@/src/services/scanQueue");
    const unsub = registerScanQueueWakeListener(wake);

    await admitScanJob({
      prId: "pr-1",
      repoId: "repo-1",
      commitHash: "abc",
      triggerReason: "prcheck",
      kind: "explicit",
    });
    expect(wake).toHaveBeenCalled();
    unsub();
  });

  it("does not wake when admit returns an already-running job", async () => {
    const job = {
      id: "same-job", prId: "pr-1", commitHash: "abc", state: "running",
      claimedAt: new Date(), leaseExpiresAt: new Date(), createdAt: new Date(),
      forced: false, resumeRequested: false, freshRequested: false,
    };
    scanJob.upsert.mockResolvedValue(job);
    const wake = vi.fn();
    const { admitScanJob, registerScanQueueWakeListener } = await import("@/src/services/scanQueue");
    const unsub = registerScanQueueWakeListener(wake);

    await admitScanJob({ prId: "pr-1", repoId: "repo-1", commitHash: "abc" });
    expect(wake).not.toHaveBeenCalled();
    unsub();
  });

  it("coalesces a duplicate revision through the unique upsert identity", async () => {
    const job = { id: "same-job", prId: "pr-1", commitHash: "abc", state: "running", claimedAt: new Date(), leaseExpiresAt: new Date(), createdAt: new Date() };
    scanJob.upsert.mockResolvedValue(job);
    const { admitScanJob } = await import("@/src/services/scanQueue");

    const first = await admitScanJob({ prId: "pr-1", repoId: "repo-1", commitHash: "abc" });
    const second = await admitScanJob({ prId: "pr-1", repoId: "repo-1", commitHash: "abc" });
    expect(first.jobId).toBe(second.jobId);
    expect(scanJob.upsert).toHaveBeenCalledTimes(2);
    expect(scanJob.upsert.mock.calls[1][0].update).toEqual({});
  });

  it("does not claim when the global active lease limit is full", async () => {
    scanJob.updateMany.mockResolvedValue({ count: 0 });
    scanJob.count.mockResolvedValue(1);
    const { claimNextScanJob } = await import("@/src/services/scanQueue");

    await expect(claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 1 })).resolves.toBeNull();
    expect(scanJob.findFirst).not.toHaveBeenCalled();
  });

  it("does not exceed a repository cap while preserving the global cap", async () => {
    scanJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
    scanJob.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    scanJob.findFirst.mockResolvedValueOnce({
      id: "job-1", prId: "pr-1", repoId: "repo-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), priority: 0,
      forced: false, resumeRequested: false, freshRequested: false, triggerReason: "auto",
      repository: { maxConcurrentScans: 1 },
    }).mockResolvedValueOnce(null);
    const { claimNextScanJob } = await import("@/src/services/scanQueue");

    await expect(claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 4 })).resolves.toBeNull();
    expect(scanJob.count).toHaveBeenLastCalledWith({
      where: { repoId: "repo-1", state: "running", leaseExpiresAt: { gt: expect.any(Date) } },
    });
    expect(scanJob.updateMany).toHaveBeenCalledTimes(2);
  });

  it("skips a capped repository when another queued repository can run", async () => {
    scanJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    scanJob.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    scanJob.findFirst
      .mockResolvedValueOnce({
        id: "job-1", prId: "pr-1", repoId: "repo-1", commitHash: "abc", state: "queued",
        claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), priority: 0,
        forced: false, resumeRequested: false, freshRequested: false, triggerReason: "auto",
        repository: { maxConcurrentScans: 1 },
      })
      .mockResolvedValueOnce({
        id: "job-2", prId: "pr-2", repoId: "repo-2", commitHash: "def", state: "queued",
        claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), priority: 0,
        forced: false, resumeRequested: false, freshRequested: false, triggerReason: "auto",
        repository: { maxConcurrentScans: null },
      });
    const { claimNextScanJob } = await import("@/src/services/scanQueue");

    await expect(claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 4 })).resolves.toMatchObject({
      jobId: "job-2",
      state: "running",
    });
    expect(scanJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "job-2", state: "queued" } }));
  });

  it("claims and releases a lease with the same worker ownership", async () => {
    const next = { id: "job-1", prId: "pr-1", commitHash: "abc", state: "queued", claimedAt: null, leaseExpiresAt: null, createdAt: new Date() };
    scanJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    scanJob.count.mockResolvedValue(0);
    scanJob.findFirst.mockResolvedValue(next);
    const { claimNextScanJob, releaseScanJob } = await import("@/src/services/scanQueue");

    const claimed = await claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 1 });
    expect(claimed).toMatchObject({ jobId: "job-1", state: "running" });
    await expect(releaseScanJob({ jobId: "job-1", workerId: "worker-1", state: "completed" })).resolves.toBe(true);
    expect(scanJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", state: "running", workerId: "worker-1" },
    }));
  });

  it("gives manual work priority over background work", async () => {
    scanJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    scanJob.count.mockResolvedValue(0);
    scanJob.findFirst.mockResolvedValue({
      id: "manual-job", prId: "pr-1", commitHash: "abc", state: "queued", priority: 10,
      triggerReason: "manual", forced: false, resumeRequested: false, freshRequested: false,
      claimedAt: null, leaseExpiresAt: null, createdAt: new Date(),
    });
    const { claimNextScanJob } = await import("@/src/services/scanQueue");

    await claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 1 });
    expect(scanJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    }));
  });

  it("recovers expired leases on startup", async () => {
    scanJob.updateMany.mockResolvedValue({ count: 2 });
    const { recoverExpiredScanJobs } = await import("@/src/services/scanQueue");
    const now = new Date("2026-07-18T01:00:00Z");

    await expect(recoverExpiredScanJobs(now)).resolves.toBe(2);
    expect(scanJob.updateMany).toHaveBeenCalledWith({
      where: { state: "running", leaseExpiresAt: { lt: now } },
      data: {
        state: "queued",
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
        resumeRequested: true,
      },
    });
  });

  it("cancels queued jobs without invoking the running abort path", async () => {
    scanJob.findUnique.mockResolvedValue({ prId: "pr-1", state: "queued" });
    scanJob.updateMany.mockResolvedValue({ count: 1 });
    const { cancelScanJobById } = await import("@/src/services/scanQueue");

    await expect(cancelScanJobById("job-1")).resolves.toBe(true);
    expect(abortScan).not.toHaveBeenCalled();
    expect(scanJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", state: { in: ["queued", "running"] } },
      data: expect.objectContaining({ state: "cancelled" }),
    }));
  });

  it("aborts running jobs and retries failed jobs", async () => {
    scanJob.findUnique.mockResolvedValueOnce({ prId: "pr-1", state: "running" });
    reviewRun.findFirst.mockResolvedValue({ id: "run-1" });
    reviewRun.update.mockResolvedValue({});
    pullRequest.updateMany.mockResolvedValue({});
    scanJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    scanJob.findUnique.mockResolvedValueOnce({
      id: "job-2", prId: "pr-2", commitHash: "def", state: "queued", priority: 0,
      triggerReason: "auto", forced: false, resumeRequested: false, freshRequested: false,
      claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), completedAt: null,
      repository: { name: "repo" }, pullRequest: { title: "PR", sourceBranch: "main" },
    });
    const { cancelScanJobById, retryFailedScanJob } = await import("@/src/services/scanQueue");

    await expect(cancelScanJobById("job-1")).resolves.toBe(true);
    expect(abortScan).toHaveBeenCalledWith("pr-1");
    await expect(retryFailedScanJob("job-2")).resolves.toMatchObject({ state: "queued", jobId: "job-2" });
    expect(scanJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-2", state: "failed" },
      data: expect.objectContaining({ state: "queued", errorMessage: null }),
    }));
  });

  it("force requeues a completed job with forced=true (cache-bypass on worker)", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    scanJob.upsert.mockResolvedValue({
      id: "job-done", prId: "pr-1", commitHash: "abc", state: "completed",
      claimedAt: null, leaseExpiresAt: null, createdAt,
      forced: false, resumeRequested: false, freshRequested: false, triggerReason: "manual",
      priority: 10, completedAt: new Date(), errorMessage: null,
    });
    scanJob.update.mockResolvedValue({
      id: "job-done", prId: "pr-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt,
      forced: true, resumeRequested: false, freshRequested: false, triggerReason: "manual",
      priority: 10, completedAt: null, errorMessage: null,
    });
    scanJob.count.mockResolvedValue(0);
    const { admitScanJob } = await import("@/src/services/scanQueue");

    await expect(admitScanJob({
      prId: "pr-1", repoId: "repo-1", commitHash: "abc", forced: true, triggerReason: "manual",
    })).resolves.toMatchObject({ jobId: "job-done", state: "queued", forced: true });
    expect(scanJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-done" },
      data: expect.objectContaining({ state: "queued", forced: true }),
    }));
  });

  it("force clears in-flight lock and requeues a running job", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    scanJob.upsert.mockResolvedValue({
      id: "job-run", prId: "pr-stuck", commitHash: "abc", state: "running",
      claimedAt: new Date(), leaseExpiresAt: new Date(), createdAt,
      forced: false, resumeRequested: false, freshRequested: false, triggerReason: "manual",
      priority: 10, workerId: "w1", completedAt: null, errorMessage: null,
    });
    reviewRun.findFirst.mockResolvedValue({ id: "run-stuck" });
    reviewRun.update.mockResolvedValue({});
    pullRequest.updateMany.mockResolvedValue({});
    scanJob.update.mockResolvedValue({
      id: "job-run", prId: "pr-stuck", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt,
      forced: true, resumeRequested: false, freshRequested: false, triggerReason: "manual",
      priority: 10, workerId: null, completedAt: null, errorMessage: null,
    });
    scanJob.count.mockResolvedValue(0);
    const { admitScanJob } = await import("@/src/services/scanQueue");

    await expect(admitScanJob({
      prId: "pr-stuck", repoId: "repo-1", commitHash: "abc", forced: true,
    })).resolves.toMatchObject({ jobId: "job-run", state: "queued", forced: true });
    expect(abortScan).toHaveBeenCalledWith("pr-stuck");
    expect(reviewRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-stuck" },
      data: expect.objectContaining({ status: "failed" }),
    }));
    expect(scanJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-run" },
      data: expect.objectContaining({
        state: "queued",
        forced: true,
        workerId: null,
        claimedAt: null,
        leaseExpiresAt: null,
      }),
    }));
  });

  it("force marks a queued job forced so the worker bypasses cache", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    scanJob.upsert.mockResolvedValue({
      id: "job-q", prId: "pr-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt,
      forced: false, resumeRequested: false, freshRequested: false, triggerReason: "auto",
      priority: 0, completedAt: null, errorMessage: null,
    });
    scanJob.update.mockResolvedValue({
      id: "job-q", prId: "pr-1", commitHash: "abc", state: "queued",
      claimedAt: null, leaseExpiresAt: null, createdAt,
      forced: true, resumeRequested: false, freshRequested: false, triggerReason: "manual",
      priority: 10, completedAt: null, errorMessage: null,
    });
    scanJob.count.mockResolvedValue(0);
    const { admitScanJob } = await import("@/src/services/scanQueue");

    await expect(admitScanJob({
      prId: "pr-1", repoId: "repo-1", commitHash: "abc", forced: true, triggerReason: "manual",
    })).resolves.toMatchObject({ state: "queued", forced: true, priority: 10 });
    expect(abortScan).not.toHaveBeenCalled();
    expect(scanJob.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ forced: true, priority: 10 }),
    }));
  });

  it("classifyQueueWorkerHttpResult marks soft-fail HTTP 200 as failed", async () => {
    const { classifyQueueWorkerHttpResult } = await import("@/src/services/scanQueue");
    expect(
      classifyQueueWorkerHttpResult(true, {
        success: false,
        systemWarn: "quality failure",
        runId: "run-1",
        terminalOutcome: { isFailed: true, reason: "quality failure" },
      }),
    ).toMatchObject({ state: "failed", reviewRunId: "run-1", errorMessage: "quality failure" });
    expect(
      classifyQueueWorkerHttpResult(true, { success: true, runId: "run-2" }),
    ).toMatchObject({ state: "completed", reviewRunId: "run-2" });
    expect(
      classifyQueueWorkerHttpResult(true, { interrupted: true, runId: "run-3" }),
    ).toMatchObject({ state: "interrupted", reviewRunId: "run-3" });
  });

  it("getScanJobForPr hides running jobs with expired leases", async () => {
    scanJob.updateMany.mockResolvedValue({ count: 0 });
    scanJob.findFirst.mockResolvedValue({
      id: "job-dead",
      prId: "pr-1",
      commitHash: "abc",
      state: "running",
      claimedAt: new Date("2026-07-18T00:00:00Z"),
      leaseExpiresAt: new Date("2020-01-01T00:00:00Z"),
      createdAt: new Date("2026-07-18T00:00:00Z"),
      forced: false,
      resumeRequested: false,
      freshRequested: false,
      priority: 0,
      triggerReason: "manual",
      completedAt: null,
      errorMessage: null,
      repository: { name: "demo" },
      pullRequest: { title: "t", sourceBranch: "feat" },
    });
    const { getScanJobForPr } = await import("@/src/services/scanQueue");
    await expect(getScanJobForPr("pr-1")).resolves.toBeNull();
  });

  it("wakes when a failed job is retried onto the queue", async () => {
    scanJob.updateMany.mockResolvedValue({ count: 1 });
    scanJob.findUnique.mockResolvedValue({
      id: "job-retry", prId: "pr-2", commitHash: "def", state: "queued", priority: 0,
      triggerReason: "manual", forced: false, resumeRequested: false, freshRequested: false,
      claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), completedAt: null,
      repository: { name: "repo" }, pullRequest: { title: "PR", sourceBranch: "feat" },
    });
    const wake = vi.fn();
    const { retryFailedScanJob, registerScanQueueWakeListener } = await import("@/src/services/scanQueue");
    const unsub = registerScanQueueWakeListener(wake);

    await expect(retryFailedScanJob("job-retry")).resolves.toMatchObject({ state: "queued", jobId: "job-retry" });
    expect(wake).toHaveBeenCalled();
    unsub();
  });

  it("worker auto-starts next queued job when a slot frees after finish (#147)", async () => {
    const createdAt = new Date("2026-07-18T00:00:00Z");
    const queued = (id: string, prId: string) => ({
      id, prId, repoId: "repo-1", commitHash: id, state: "queued" as const,
      claimedAt: null, leaseExpiresAt: null, createdAt, priority: 10,
      forced: false, resumeRequested: false, freshRequested: false,
      triggerReason: "prcheck", repository: { name: "demo", maxConcurrentScans: null },
    });

    // startup recoverExpiredScanJobs
    scanJob.updateMany.mockResolvedValue({ count: 0 });
    scanJob.count.mockResolvedValue(0);
    const queue = [queued("job-a", "pr-a"), queued("job-b", "pr-b")];
    scanJob.findFirst.mockImplementation(async () => queue.shift() ?? null);
    // claim: expired recovery + priority normalize + claim update (per claim)
    scanJob.updateMany.mockImplementation(async (args: { where?: { id?: string; state?: unknown }; data?: { state?: string } }) => {
      if (args?.where && "id" in (args.where ?? {}) && args.data?.state === "running") {
        return { count: 1 };
      }
      if (args?.data?.state && args.data.state !== "queued" && args.data.state !== "running") {
        return { count: 1 }; // release
      }
      return { count: 0 };
    });

    const executed: string[] = [];
    const { startScanQueueWorker } = await import("@/src/services/scanQueue");
    const stop = startScanQueueWorker({
      intervalMs: 60_000, // must not rely on poll interval
      workerId: "worker-slot-free",
      execute: async (job) => {
        executed.push(job.jobId);
        return { state: "completed" };
      },
    });

    for (let i = 0; i < 40 && executed.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    stop();
    expect(executed).toEqual(["job-a", "job-b"]);
  });

  it("worker wake registration fires tick when a job becomes queued (#147)", async () => {
    scanJob.updateMany.mockResolvedValue({ count: 0 });
    scanJob.count.mockResolvedValue(0);
    let claimed = false;
    scanJob.findFirst.mockImplementation(async () => {
      if (claimed) return null;
      claimed = true;
      return {
        id: "job-wake-worker", prId: "pr-w", repoId: "repo-1", commitHash: "w1", state: "queued",
        claimedAt: null, leaseExpiresAt: null, createdAt: new Date(), priority: 10,
        forced: false, resumeRequested: false, freshRequested: false, triggerReason: "manual",
        repository: { name: "demo", maxConcurrentScans: null },
      };
    });
    scanJob.updateMany.mockImplementation(async (args: { data?: { state?: string } }) => {
      if (args?.data?.state === "running") return { count: 1 };
      if (args?.data?.state === "completed") return { count: 1 };
      return { count: 0 };
    });

    // First: recover returns 0, initial tick finds nothing (claimed stays false until we force)
    claimed = true; // block initial tick
    const executed: string[] = [];
    const {
      startScanQueueWorker,
      notifyScanQueueWake,
    } = await import("@/src/services/scanQueue");
    const stop = startScanQueueWorker({
      intervalMs: 60_000,
      workerId: "worker-wake",
      execute: async (job) => {
        executed.push(job.jobId);
        return { state: "completed" };
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(executed).toEqual([]);

    claimed = false; // job becomes available
    notifyScanQueueWake();
    for (let i = 0; i < 40 && executed.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    stop();
    expect(executed).toEqual(["job-wake-worker"]);
  });

});
