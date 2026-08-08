import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: "run-1",
        repoId: "repo-1",
        pullRequest: { sourceBranch: "feature" },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({
        id: "repo-1",
        path: "/fake/repo",
        securitySensitivePaths: null,
        installationId: null,
      }),
    },
    pullRequest: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewChunk: {
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ leaseVersion: 1 }),
    },
  },
}));

vi.mock("../../src/services/largePrReview/chunker", () => ({
  chunkDiff: vi.fn().mockReturnValue([]),
  CHUNK_LINE_CAP: 600,
  MIN_USEFUL_CHUNK_LINES: 50,
}));

vi.mock("../../src/lib/prSizeConfig", () => {
  const limits = {
    chunkLineCap: 600,
    minUsefulChunkLines: 50,
    normalMaxLines: 800,
    normalMaxCodeFiles: 40,
    oversizedLines: 3000,
    oversizedCodeFiles: 100,
    maxFilesPerReview: 0,
  };
  return {
    DEFAULT_LIMITS: limits,
    readLimits: vi.fn().mockReturnValue(limits),
    clearLimitsCache: vi.fn(),
    tierThresholdsFromLimits: (l = limits) => ({
      normalMaxLines: l.normalMaxLines,
      normalMaxCodeFiles: l.normalMaxCodeFiles,
      oversizedLines: l.oversizedLines,
      oversizedCodeFiles: l.oversizedCodeFiles,
    }),
    effectiveChunkLineCap: (l = limits) => Math.max(l.chunkLineCap, l.normalMaxLines),
    chunkOptionsFromLimits: (l = limits) => ({
      chunkLineCap: Math.max(l.chunkLineCap, l.normalMaxLines),
      minUsefulChunkLines: l.minUsefulChunkLines,
    }),
  };
});

vi.mock("../../src/services/largePrReview/globalDeterministicChecks", () => ({
  runGlobalDeterministicChecks: vi.fn().mockResolvedValue({
    abort: false,
    findings: [],
  }),
}));

import { claimChunk, releaseChunk, runLargePrReview } from "../../src/services/largePrReview/orchestrator";

describe("runLargePrReview — zero plans (no code files)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns rating: null and systemWarn when chunk plans are empty", async () => {
    const result = await runLargePrReview({
      reviewRunId: "run-1",
      prId: "pr-1",
      files: [{ filename: "README.md", additions: 10, deletions: 0 }],
    });

    expect(result.success).toBe(true);
    expect(result.rating).toBeNull();
    expect(result.systemWarn).toBe(
      "No code files to review — all changes are documentation, generated, or lockfile changes",
    );
    expect(result.reliability).toBe("complete");
    expect(result.largePrMode).toBe(true);
  });

  it("persists rating: null and status: completed in the database", async () => {
    const { prisma } = await import("../../src/lib/prisma");

    await runLargePrReview({
      reviewRunId: "run-1",
      prId: "pr-1",
      files: [{ filename: "CHANGELOG.md", additions: 50, deletions: 0 }],
    });

    expect(prisma.reviewRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "completed",
          rating: null,
        }),
      }),
    );

    expect(prisma.pullRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pr-1" },
        data: expect.objectContaining({
          status: "Completed",
          rating: null,
        }),
      }),
    );
  });
});

describe("large-PR chunk leases", () => {
  it("claims a chunk atomically and fences release to its owner", async () => {
    const { prisma } = await import("../../src/lib/prisma");
    const claimed = await claimChunk("run-1", "run-1-chunk-a", "worker-a");
    expect(claimed).toBe(1);
    expect(prisma.reviewChunk.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "run-1-chunk-a", reviewRunId: "run-1" }),
      data: expect.objectContaining({ leaseOwner: "worker-a", status: "running" }),
    }));

    await releaseChunk("run-1", "run-1-chunk-a", "worker-a", 1, { status: "completed", rating: 8 });
    expect(prisma.reviewChunk.updateMany).toHaveBeenLastCalledWith({
      where: { id: "run-1-chunk-a", reviewRunId: "run-1", leaseOwner: "worker-a", leaseVersion: 1 },
      data: expect.objectContaining({ status: "completed", leaseOwner: null, leaseExpiresAt: null }),
    });
  });

  it("does not treat a lost atomic claim as a chunk failure", async () => {
    const { prisma } = await import("../../src/lib/prisma");
    (prisma.reviewChunk.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    await expect(claimChunk("run-1", "run-1-chunk-a", "worker-b")).resolves.toBeNull();
  });
});
