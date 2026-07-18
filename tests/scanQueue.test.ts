import { beforeEach, describe, expect, it, vi } from "vitest";

const scanJob = {
  upsert: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
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
      data: { state: "queued", workerId: null, claimedAt: null, leaseExpiresAt: null },
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
});
