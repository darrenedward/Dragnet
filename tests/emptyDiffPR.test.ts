import { describe, expect, it, vi, beforeEach } from "vitest";

const create = vi.fn();

function fakeClient() {
  return { chat: { completions: { create } } } as any;
}

const prismaMocks = vi.hoisted(() => ({
  reviewRunFindFirst: vi.fn(),
  pullRequestUpdateMany: vi.fn(),
  reviewHistoryCreate: vi.fn(),
  completeReviewRun: vi.fn(),
}));

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: () => [
    {
      client: fakeClient(),
      model: "test-model",
      name: "Test",
      endpoint: "https://test.example.com/v1",
      maxIterations: 4,
    },
  ],
  getChatClient: () => fakeClient(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "pr-empty",
        repoId: "repo-empty",
        title: "Empty PR",
        description: "No changes here",
        sourceBranch: "feature/empty",
        commitHash: "abc123",
      }),
      updateMany: prismaMocks.pullRequestUpdateMany,
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({ id: "repo-empty", path: null, localPath: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findFirst: prismaMocks.reviewRunFindFirst,
      findUnique: vi.fn().mockResolvedValue({ id: "run-empty", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewHistory: { create: prismaMocks.reviewHistoryCreate },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks: vi.fn().mockResolvedValue([]),
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue([]),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/reviewFreshness", () => ({
  completeReviewRun: prismaMocks.completeReviewRun,
  setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
  setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/largePrReview/fingerprint", () => ({
  buildFindingFingerprint: vi.fn().mockReturnValue("fp"),
  resolveSymbolsBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
  dedupFindingsWithinRun: vi.fn().mockResolvedValue(0),
}));

describe("Empty-diff PR handling — issue #61", () => {
  beforeEach(() => {
    create.mockClear();
    prismaMocks.reviewRunFindFirst.mockReset().mockResolvedValue(null);
    prismaMocks.pullRequestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMocks.reviewHistoryCreate.mockReset().mockResolvedValue({});
    prismaMocks.completeReviewRun.mockReset().mockResolvedValue(undefined);
  });

  it("returns cached rating when prior completed ReviewRun exists", async () => {
    const { runPrScan } = await import("../reviewService");
    prismaMocks.reviewRunFindFirst.mockResolvedValue({ rating: 8 });

    const result = await runPrScan("pr-empty");

    expect(result.success).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.findings).toEqual([]);
    expect(result.usedModel).toBe("cached (no code changes)");
    expect(result.systemWarn).toContain("cached");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null rating with actionable systemWarn when no cache exists", async () => {
    const { runPrScan } = await import("../reviewService");

    const result = await runPrScan("pr-empty");

    expect(result.success).toBe(true);
    expect(result.rating).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.usedModel).toBe("unconfigured");
    expect(result.systemWarn).toBe(
      "No code changes detected. Push your changes and re-scan. If this PR is intentionally empty, close it.",
    );
  });

  it("makes no LLM call for empty-diff PR", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty");

    expect(create).not.toHaveBeenCalled();
  });

  it("sets PR status to Completed with null rating", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty");

    expect(prismaMocks.pullRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: "pr-empty" },
      data: { status: "Completed", rating: null },
    });
  });

  it("completes ReviewRun when reviewRunId is provided", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty", undefined, "run-abc");

    expect(prismaMocks.completeReviewRun).toHaveBeenCalledWith("run-abc", {
      status: "completed",
      rating: null,
      refused: false,
      outcome: "reviewed",
    });
  });

  it("creates reviewHistory audit trail", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty");

    expect(prismaMocks.reviewHistoryCreate).toHaveBeenCalledTimes(1);
  });

  it("includes reviewConfigHash in cache lookup when options provide it", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty", undefined, undefined, undefined, undefined, {
      checkpointMetadata: {
        commitHash: "abc123",
        diffHash: "def456",
        reviewConfigHash: "config-hash-xyz",
      },
    });

    expect(prismaMocks.reviewRunFindFirst).toHaveBeenCalledWith({
      where: {
        prId: "pr-empty",
        status: "completed",
        rating: { not: null },
        reviewConfigHash: "config-hash-xyz",
      },
      orderBy: { completedAt: "desc" },
      select: { rating: true },
    });
  });

  it("omits reviewConfigHash from cache lookup when options are absent", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty");

    expect(prismaMocks.reviewRunFindFirst).toHaveBeenCalledWith({
      where: {
        prId: "pr-empty",
        status: "completed",
        rating: { not: null },
      },
      orderBy: { completedAt: "desc" },
      select: { rating: true },
    });
  });

  it("returns cached rating when reviewConfigHash matches", async () => {
    const { runPrScan } = await import("../reviewService");
    prismaMocks.reviewRunFindFirst.mockResolvedValue({ rating: 9 });

    const result = await runPrScan("pr-empty", undefined, undefined, undefined, undefined, {
      checkpointMetadata: {
        commitHash: "abc123",
        diffHash: "def456",
        reviewConfigHash: "matching-hash",
      },
    });

    expect(result.success).toBe(true);
    expect(result.rating).toBe(9);
    expect(result.usedModel).toBe("cached (no code changes)");
    expect(create).not.toHaveBeenCalled();
  });

  it("falls through to no-cache path when reviewConfigHash does not match (simulated by null return)", async () => {
    const { runPrScan } = await import("../reviewService");

    const result = await runPrScan("pr-empty", undefined, undefined, undefined, undefined, {
      checkpointMetadata: {
        commitHash: "abc123",
        diffHash: "def456",
        reviewConfigHash: "new-config",
      },
    });

    expect(result.success).toBe(true);
    expect(result.rating).toBeNull();
    expect(result.systemWarn).toBe(
      "No code changes detected. Push your changes and re-scan. If this PR is intentionally empty, close it.",
    );
  });
});
