import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewRun = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
const pullRequest = {
  findUnique: vi.fn(),
};
const reviewFinding = { findMany: vi.fn() };
const reviewLog = { findMany: vi.fn() };

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    reviewRun,
    pullRequest,
    reviewFinding,
    reviewLog,
  },
}));

describe("getActiveScan ghost reap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewFinding.findMany.mockResolvedValue([]);
    reviewLog.findMany.mockResolvedValue([]);
  });

  it("returns null and reaps in_progress when PR is already Failed", async () => {
    reviewRun.findFirst.mockResolvedValue({
      id: "run-ghost",
      prId: "pr-1",
      commitHash: "abc",
      diffHash: "diff",
      startedAt: new Date(),
      triggerReason: "manual",
      model: "x",
      chunksTotal: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksSkipped: 0,
    });
    pullRequest.findUnique.mockResolvedValue({ status: "Failed" });
    reviewRun.update.mockResolvedValue({});

    const { getActiveScan } = await import("../src/lib/reviewFreshness");
    await expect(getActiveScan("pr-1")).resolves.toEqual({
      reviewRun: null,
      findings: [],
      iterationsByChunk: {},
    });
    expect(reviewRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-ghost" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("returns the live run when PR is In Progress", async () => {
    const run = {
      id: "run-live",
      prId: "pr-1",
      commitHash: "abc",
      diffHash: "diff",
      startedAt: new Date(),
      triggerReason: "manual",
      model: "x",
      chunksTotal: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksSkipped: 0,
    };
    reviewRun.findFirst.mockResolvedValue(run);
    pullRequest.findUnique.mockResolvedValue({ status: "In Progress" });

    const { getActiveScan } = await import("../src/lib/reviewFreshness");
    const result = await getActiveScan("pr-1");
    expect(result.reviewRun?.id).toBe("run-live");
    expect(reviewRun.update).not.toHaveBeenCalled();
  });
});
