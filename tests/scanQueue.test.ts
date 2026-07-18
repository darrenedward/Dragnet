import { beforeEach, describe, expect, it, vi } from "vitest";

const scanJob = {
  upsert: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
};
const prismaMock = {
  scanJob,
  $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock)),
};

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/prSizeConfig", () => ({ readLimits: () => ({ maxConcurrentScans: 1 }) }));

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
    scanJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    scanJob.count.mockResolvedValue(0);
    scanJob.findFirst.mockResolvedValue(next);
    const { claimNextScanJob, releaseScanJob } = await import("@/src/services/scanQueue");

    const claimed = await claimNextScanJob({ workerId: "worker-1", maxConcurrentScans: 1 });
    expect(claimed).toMatchObject({ jobId: "job-1", state: "running" });
    await expect(releaseScanJob({ jobId: "job-1", workerId: "worker-1", state: "completed" })).resolves.toBe(true);
    expect(scanJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "job-1", state: "running", workerId: "worker-1" },
    }));
  });
});
