import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeterministicFinding } from "@/src/services/deterministicChecks";

const { runDeterministicChecksMock, runContainerizedChecksMock } = vi.hoisted(() => ({
  runDeterministicChecksMock: vi.fn(),
  runContainerizedChecksMock: vi.fn(),
}));

vi.mock("../../src/services/deterministicChecks", () => ({
  runDeterministicChecks: runDeterministicChecksMock,
  runContainerizedChecks: runContainerizedChecksMock,
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/buildsystemDetect", () => ({
  detectBuildSystem: vi.fn().mockResolvedValue({ buildSystem: "node", image: "node:20-alpine", warn: null }),
}));

vi.mock("../../src/lib/crypto", () => ({
  decryptSecret: vi.fn((cipher: string) => `decrypted-${cipher}`),
  hasMasterKey: vi.fn(() => true),
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "pr-1",
        repoId: "repo-1",
        title: "Test PR",
        description: "test",
        commitHash: "abc123",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({
        id: "repo-1",
        path: "/fake/repo",
        localPath: null,
        cloneUrl: null,
        skipTier2: false,
        runnerImage: "node:20-alpine",
        installCommand: "npm install",
        testCommand: "npm test",
        deployKeyCipher: null,
        deployKeyIv: null,
        deployKeyTag: null,
        patCipher: null,
        patIv: null,
        patTag: null,
      }),
    },
    prFile: {
      findMany: vi.fn().mockResolvedValue([
        { filename: "src/test.ts", diff: "diff --git a/src/test.ts b/src/test.ts\n+const x = 1;", modifiedContent: "const x = 1;", additions: 1, deletions: 0 },
      ]),
    },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "in_progress", repoId: "repo-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewFinding: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
    reviewHistory: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    reviewChunk: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../../src/lib/llmClient", () => ({
  getChatChain: () => [],
  getChatClient: () => null,
}));

vi.mock("../../src/lib/llmPresets", () => ({
  getPrimaryChatPreset: () => null,
}));

vi.mock("../../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue([]),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/lib/reviewFreshness", () => ({
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
  setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
  setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/largePrReview/reconcile", () => ({
  dedupFindingsWithinRun: vi.fn().mockResolvedValue(undefined),
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue(undefined),
}));

import { runPrScan } from "../../reviewService";
import { runGlobalDeterministicChecks } from "../../src/services/largePrReview/globalDeterministicChecks";

function mockFinding(explanation: string): DeterministicFinding {
  return {
    filename: "src/test.ts",
    line: 1,
    severity: "error",
    category: "correctness",
    explanation,
    source: "tsc",
  };
}

// ---------------------------------------------------------------------------
// runPrScan with precomputedFindings
// ---------------------------------------------------------------------------
describe("runPrScan with precomputedFindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips Tier 1+2 pipeline when precomputedFindings are provided", async () => {
    const precomputed = [mockFinding("tsc error from global scan")];
    const result = await runPrScan("pr-1", undefined, "run-1", "chunk-1", undefined, {
      precomputedFindings: precomputed,
    });

    expect(runDeterministicChecksMock).not.toHaveBeenCalled();
    expect(runContainerizedChecksMock).not.toHaveBeenCalled();
    expect(result.findings).toEqual(precomputed);
  });

  it("still runs Tier 1+2 when precomputedFindings is not set", async () => {
    runDeterministicChecksMock.mockResolvedValue([]);
    runContainerizedChecksMock.mockResolvedValue([]);

    await runPrScan("pr-1", undefined, "run-1", "chunk-1");

    expect(runDeterministicChecksMock).toHaveBeenCalled();
  });

  it("includes precomputed findings in the result output", async () => {
    const precomputed = [mockFinding("pre-existing lint error")];
    const result = await runPrScan("pr-1", undefined, "run-1", "chunk-1", undefined, {
      precomputedFindings: precomputed,
    });

    expect(result.findings.some(
      (f: any) => f.explanation === "pre-existing lint error",
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runGlobalDeterministicChecks
// ---------------------------------------------------------------------------
describe("runGlobalDeterministicChecks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs Tier 1 and Tier 2 and returns combined findings", async () => {
    runDeterministicChecksMock.mockResolvedValue([{ ...mockFinding("tsc warning"), severity: "warning" as const }]);
    runContainerizedChecksMock.mockResolvedValue([mockFinding("test failure")]);

    const result = await runGlobalDeterministicChecks("run-1", "pr-1");

    expect(result.abort).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].explanation).toBe("tsc warning");
    expect(result.findings[1].explanation).toBe("test failure");
  });

  it("aborts on Tier 2 infrastructure failure", async () => {
    runDeterministicChecksMock.mockResolvedValue([]);
    runContainerizedChecksMock.mockRejectedValue(new Error("Docker daemon unreachable"));

    const result = await runGlobalDeterministicChecks("run-1", "pr-1");

    expect(result.abort).toBe(true);
    expect(result.infrastructureFailure).toBe(true);
    expect(result.errorMessage).toContain("Docker daemon unreachable");
  });

  it("recovers from Tier 1 crash with info finding", async () => {
    runDeterministicChecksMock.mockRejectedValue(new Error("tsc binary not found"));
    runContainerizedChecksMock.mockResolvedValue([]);

    const result = await runGlobalDeterministicChecks("run-1", "pr-1");

    expect(result.abort).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings.some(
      (f) => f.source === "runner" && f.explanation.includes("Tier 1"),
    )).toBe(true);
  });

  it("skips Tier 2 when skipTier2 is true", async () => {
    const prismaMod = await import("../../src/lib/prisma");
    (prismaMod.prisma.repository.findUnique as any).mockResolvedValue({
      id: "repo-1",
      path: "/fake/repo",
      localPath: null,
      cloneUrl: null,
      skipTier2: true,
      runnerImage: "node:20-alpine",
      installCommand: "npm install",
      testCommand: "npm test",
      deployKeyCipher: null,
      deployKeyIv: null,
      deployKeyTag: null,
      patCipher: null,
      patIv: null,
      patTag: null,
    });

    runDeterministicChecksMock.mockResolvedValue([]);

    const result = await runGlobalDeterministicChecks("run-1", "pr-1");

    expect(result.abort).toBe(false);
    expect(runContainerizedChecksMock).not.toHaveBeenCalled();
  });

  it("skips Tier 2 when Tier 1 has errors", async () => {
    runDeterministicChecksMock.mockResolvedValue([
      { filename: "src/test.ts", line: 1, severity: "error", category: "correctness", explanation: "type error", source: "tsc" },
    ]);

    const result = await runGlobalDeterministicChecks("run-1", "pr-1");

    expect(result.abort).toBe(false);
    expect(runContainerizedChecksMock).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].source).toBe("tsc");
  });
});
