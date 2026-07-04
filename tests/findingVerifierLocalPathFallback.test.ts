import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const verifyFindingsSpy = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: verifyFindingsSpy,
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "pr-vf",
        repoId: "repo-vf",
        title: "Verifier PR",
        description: "test",
        sourceBranch: "feat",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repository: {
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: "repo-vf",
          path: null,
          localPath: tmpRepo,
          securitySensitivePaths: [],
        }),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-vf", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewFinding: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
  },
}));

const fakeClient = vi.hoisted(() => {
  return { chat: { completions: { create: vi.fn() } } } as any;
});

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: () => [
    {
      client: fakeClient,
      model: "test-model",
      name: "Test",
      endpoint: "https://test.example.com/v1",
      maxIterations: 4,
    },
  ],
  getChatClient: () => fakeClient,
}));

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks: vi.fn().mockResolvedValue([]),
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/reviewFreshness", () => ({
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
  setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
  setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/largePrReview/fingerprint", () => ({
  buildFindingFingerprint: vi.fn().mockReturnValue("fp"),
  resolveSymbolsBatch: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
}));

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-vf-"));
  verifyFindingsSpy.mockClear();
  verifyFindingsSpy.mockResolvedValue(new Map());
  fakeClient.chat.completions.create.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("findingVerifier remote repo fallback", () => {
  it("falls through to repo.localPath when repo.path is null", async () => {
    fakeClient.chat.completions.create.mockResolvedValue({
      choices: [{
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [{
            id: "call-sr",
            function: {
              name: "submitReview",
              arguments: JSON.stringify({
                rating: 8,
                summary: "good",
                findings: [
                  {
                    category: "Security",
                    severity: "blocker",
                    filename: "auth.ts",
                    line: 14,
                    explanation: "auth check missing",
                  },
                ],
              }),
            },
          }],
        },
      }],
      usage: null,
    });

    const { runPrScan } = await import("../reviewService");
    const result = await runPrScan(
      "pr-vf",
      [
        {
          filename: "src/test.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "export const x = 1;\n",
          diff: "+export const x = 1;\n",
        },
      ],
      "run-vf",
    );

    expect(result.success).toBe(true);
    expect(result.rating).toBe(8);

    expect(verifyFindingsSpy).toHaveBeenCalledTimes(1);
    const callArgs = verifyFindingsSpy.mock.calls[0];
    expect(callArgs[1]).toBe(tmpRepo);
  });
});
