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
    });
  });

  it("creates reviewHistory audit trail", async () => {
    const { runPrScan } = await import("../reviewService");

    await runPrScan("pr-empty");

    expect(prismaMocks.reviewHistoryCreate).toHaveBeenCalledTimes(1);
  });
});
