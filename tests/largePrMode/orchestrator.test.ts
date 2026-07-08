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
    },
  },
}));

vi.mock("../../src/services/largePrReview/chunker", () => ({
  chunkDiff: vi.fn().mockReturnValue([]),
  CHUNK_LINE_CAP: 600,
  MIN_USEFUL_CHUNK_LINES: 50,
}));

vi.mock("../../src/lib/prSizeConfig", () => ({
  readLimits: vi.fn().mockReturnValue({
    chunkLineCap: 600,
    minUsefulChunkLines: 50,
    normalMaxLines: 800,
    normalMaxCodeFiles: 40,
    oversizedLines: 3000,
    oversizedCodeFiles: 100,
    maxFilesPerReview: 0,
  }),
  clearLimitsCache: vi.fn(),
}));

vi.mock("../../src/services/largePrReview/globalDeterministicChecks", () => ({
  runGlobalDeterministicChecks: vi.fn().mockResolvedValue({
    abort: false,
    findings: [],
  }),
}));

import { runLargePrReview } from "../../src/services/largePrReview/orchestrator";

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
