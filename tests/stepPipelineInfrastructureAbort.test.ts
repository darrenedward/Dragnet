import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { create, updateMany, runContainerizedChecks } = vi.hoisted(() => ({
  create: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  runContainerizedChecks: vi.fn().mockRejectedValue(new Error("Docker daemon not responding")),
}));

function fakeClient() {
  return { chat: { completions: { create } } } as any;
}

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
        id: "pr-infra",
        repoId: "repo-infra",
        title: "Infrastructure Abort PR",
        description: "test",
      }),
      updateMany,
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({ id: "repo-infra", path: "/tmp/repo", localPath: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-infra", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewFinding: { deleteMany: vi.fn().mockResolvedValue({}) },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks,
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue([]),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/reviewFreshness", () => ({
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../src/lib/buildsystemDetect", () => ({
  detectBuildSystem: vi.fn().mockResolvedValue({
    buildSystem: "node",
    image: "node:20-alpine",
    warn: null,
  }),
}));

describe("StepPipeline infrastructure abort in runPrScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runContainerizedChecks.mockRejectedValue(new Error("Docker daemon not responding"));
  });

  it("infrastructure failure in Tier 2 sets PR status to Failed and aborts before LLM", async () => {
    const { runPrScan } = await import("../reviewService");

    const result = await runPrScan("pr-infra", [
      {
        filename: "src/test.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        originalContent: "",
        modifiedContent: "export const x = 1;\n",
        diff: "+export const x = 1;\n",
      },
    ], "run-infra");

    expect(result.success).toBe(false);
    expect(result.infrastructureFailure).toBe(true);
    expect(result.rating).toBeNull();
    expect(result.usedModel).toBe("none");
    expect(result.systemWarn).toMatch(/Infrastructure failure/i);
    expect(result.findings).toEqual([]);

    const failedCalls = updateMany.mock.calls.filter(
      ([args]: any[]) => args?.data?.status === "Failed",
    );
    expect(failedCalls.length).toBeGreaterThanOrEqual(1);

    expect(create).not.toHaveBeenCalled();
  });

  it("happy path — no infrastructure failure returns success", async () => {
    runContainerizedChecks.mockResolvedValue([]);
    create.mockResolvedValue({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "submitReview",
              arguments: JSON.stringify({ rating: 8, summary: "ok", findings: [] }),
            },
          }],
        },
      }],
    });

    const { runPrScan } = await import("../reviewService");

    const result = await runPrScan("pr-infra", [
      {
        filename: "src/test.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        originalContent: "",
        modifiedContent: "export const x = 1;\n",
        diff: "+export const x = 1;\n",
      },
    ], "run-infra");

    expect(result.success).toBe(true);
    expect(result.infrastructureFailure).toBeUndefined();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
