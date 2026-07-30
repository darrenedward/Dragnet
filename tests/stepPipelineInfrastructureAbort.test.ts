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
  shouldRunHostTier1: (repo?: { path?: string | null; cloneUrl?: string | null; localPath?: string | null } | null) =>
    Boolean(repo?.path) && !repo?.cloneUrl && repo?.localPath !== "/workspace",
  DEFAULT_INSTALL_COMMAND: "npm install",
  DEFAULT_TEST_COMMAND: "npm run typecheck && npm run lint",
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

const detectBuildSystem = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    buildSystem: "node",
    image: "node:20-alpine",
    warn: null,
  }),
);

vi.mock("../src/lib/buildsystemDetect", () => ({
  detectBuildSystem,
}));

describe("StepPipeline infrastructure abort in runPrScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runContainerizedChecks.mockRejectedValue(new Error("Docker daemon not responding"));
    detectBuildSystem.mockResolvedValue({
      buildSystem: "node",
      image: "node:20-alpine",
      warn: null,
    });
  });

  it("infrastructure failure in Tier 2 sets PR status to Failed and aborts before LLM", async () => {
    const { runPrScan } = await import("../src/services/reviewService");

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

    const { runPrScan } = await import("../src/services/reviewService");

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

  it("remote/volume repo skips host Tier 1 and still runs Tier 2", async () => {
    const prismaMod = await import("../src/lib/prisma");
    (prismaMod.prisma.repository.findUnique as any).mockResolvedValue({
      id: "repo-infra",
      path: "/stale/mirror",
      localPath: "/workspace",
      cloneUrl: "https://github.com/acme/app.git",
      skipTier2: false,
      runnerImage: "node:20-alpine",
      installCommand: "npm install",
      testCommand: "npm run typecheck && npm run lint",
    });
    // Stale host mirror has no package.json — host detect would say "unknown"
    // and must not disable container Tier 2 for remote/volume repos.
    detectBuildSystem.mockResolvedValue({
      buildSystem: "unknown",
      image: "node:20-alpine",
      warn: "No recognized build config found",
    });
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

    const det = await import("../src/services/deterministicChecks");
    const { runPrScan } = await import("../src/services/reviewService");

    await runPrScan("pr-infra", [
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

    expect(det.runDeterministicChecks).not.toHaveBeenCalled();
    expect(detectBuildSystem).not.toHaveBeenCalled();
    expect(runContainerizedChecks).toHaveBeenCalled();
  });

  it("install failure aborts with systemWarn and no LLM call", async () => {
    const prismaMod = await import("../src/lib/prisma");
    (prismaMod.prisma.repository.findUnique as any).mockResolvedValue({
      id: "repo-infra",
      path: null,
      localPath: "/workspace",
      cloneUrl: "https://github.com/acme/app.git",
      skipTier2: false,
      runnerImage: "node:20-alpine",
      installCommand: "npm install",
      testCommand: "npm run typecheck && npm run lint",
    });
    runContainerizedChecks.mockRejectedValue(
      new Error("Containerized checks: install failed (exit 1) — aborting before quality gates and LLM"),
    );

    const { runPrScan } = await import("../src/services/reviewService");

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
    expect(result.systemWarn).toMatch(/Infrastructure failure/i);
    expect(create).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
