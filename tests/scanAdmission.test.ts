import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #90 / #84 — explicit review always admits a scan queue job; auto-rescan
 * only gates background AFK enqueue.
 */

const scanJob = {
  upsert: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};
const pullRequest = { findUnique: vi.fn() };
const repository = { findUnique: vi.fn() };
const prismaMock = {
  scanJob,
  pullRequest,
  repository,
  $transaction: vi.fn(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock)),
};

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/prSizeConfig", () => ({ readLimits: () => ({ maxConcurrentScans: 1 }) }));

const autoRescan = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/src/lib/autoRescanPolicy", () => ({
  isAutoRescanEnabledForRepo: vi.fn(async () => autoRescan.enabled),
  isAutoRescanEnabled: vi.fn((override: string | null | undefined) => {
    if (override === "enabled") return true;
    if (override === "disabled") return false;
    return autoRescan.enabled;
  }),
}));

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    prId: "pr-1",
    repoId: "repo-1",
    commitHash: "abc",
    state: "queued",
    claimedAt: null,
    leaseExpiresAt: null,
    forced: false,
    resumeRequested: false,
    freshRequested: false,
    priority: 10,
    triggerReason: "prcheck",
    createdAt: new Date("2026-07-18T00:00:00Z"),
    completedAt: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("explicit vs AFK scan admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoRescan.enabled = false;
    scanJob.count.mockResolvedValue(0);
    scanJob.updateMany.mockResolvedValue({ count: 0 });
  });

  it("explicit prcheck admits even when auto-rescan is disabled", async () => {
    autoRescan.enabled = false;
    scanJob.upsert.mockResolvedValue(queuedJob({ triggerReason: "prcheck", priority: 10 }));
    const { admitScanJob } = await import("@/src/services/scanQueue");

    const job = await admitScanJob({
      prId: "pr-1",
      repoId: "repo-1",
      commitHash: "abc",
      triggerReason: "prcheck",
      kind: "explicit",
    });

    expect(job).toMatchObject({ jobId: "job-1", state: "queued", triggerReason: "prcheck" });
    expect(scanJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          triggerReason: "prcheck",
          priority: 10,
        }),
      }),
    );
  });

  it("AFK admit returns null when auto-rescan is disabled (no queue job)", async () => {
    autoRescan.enabled = false;
    pullRequest.findUnique.mockResolvedValue({ repoId: "repo-1", commitHash: "abc" });
    const { admitAfkScanJobForPr } = await import("@/src/services/scanQueue");

    await expect(
      admitAfkScanJobForPr({ prId: "pr-1", triggerReason: "webhook" }),
    ).resolves.toBeNull();
    expect(scanJob.upsert).not.toHaveBeenCalled();
  });

  it("AFK admit enqueues when auto-rescan is enabled", async () => {
    autoRescan.enabled = true;
    pullRequest.findUnique.mockResolvedValue({ repoId: "repo-1", commitHash: "abc" });
    scanJob.upsert.mockResolvedValue(
      queuedJob({ triggerReason: "webhook", priority: 0, state: "queued" }),
    );
    const { admitAfkScanJobForPr } = await import("@/src/services/scanQueue");

    const job = await admitAfkScanJobForPr({ prId: "pr-1", triggerReason: "webhook" });
    expect(job).toMatchObject({ jobId: "job-1", state: "queued", triggerReason: "webhook" });
    expect(scanJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          triggerReason: "webhook",
          priority: 0,
        }),
      }),
    );
  });

  it("AFK admit does not requeue a completed job for the same revision", async () => {
    autoRescan.enabled = true;
    pullRequest.findUnique.mockResolvedValue({ repoId: "repo-1", commitHash: "abc" });
    scanJob.upsert.mockResolvedValue(
      queuedJob({
        state: "completed",
        triggerReason: "webhook",
        priority: 0,
        completedAt: new Date(),
      }),
    );
    const { admitAfkScanJobForPr } = await import("@/src/services/scanQueue");

    const job = await admitAfkScanJobForPr({ prId: "pr-1", triggerReason: "webhook" });
    expect(job?.state).toBe("completed");
    expect(scanJob.update).not.toHaveBeenCalled();
  });

  it("derive kind: prcheck/prepush/manual are explicit; webhook/auto/polling are AFK", async () => {
    const { resolveAdmitKind } = await import("@/src/services/scanQueue");
    expect(resolveAdmitKind("prcheck")).toBe("explicit");
    expect(resolveAdmitKind("prepush")).toBe("explicit");
    expect(resolveAdmitKind("manual")).toBe("explicit");
    expect(resolveAdmitKind("webhook")).toBe("afk");
    expect(resolveAdmitKind("auto")).toBe("afk");
    expect(resolveAdmitKind("polling")).toBe("afk");
    expect(resolveAdmitKind("webhook", "explicit")).toBe("explicit");
  });
});
