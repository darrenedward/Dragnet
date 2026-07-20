import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Service-layer outcome-persistence tests for issue #19.
 *
 * The nullable `ReviewRun.outcome` column ("reviewed" | "skipped" | null)
 * is the user-facing terminal classification, orthogonal to lifecycle
 * `status`. These tests assert the column is populated correctly at
 * each terminal branch of `runPrScan`:
 *
 *   1. Trivial-skip path (Tier 1+2 clean + diff is config/docs) → outcome="skipped"
 *   2. Successful-review path (LLM produced a rating)            → outcome="reviewed"
 *   3. Empty-diff no-prior-cache path (0 files, no cached grade) → outcome="reviewed"
 *   4. Failure path (LLM chain failure / pipeline abort)         → outcome field absent (null)
 *
 * Mock posture mirrors `tests/emptyDiffPR.test.ts` and
 * `tests/reviewServiceFallbackRegression.test.ts`.
 */

const hoisted = vi.hoisted(() => {
  // Hoist everything the vi.mock factories reference — vi.mock runs
  // before module-level consts initialize, so any closure capture
  // must live inside vi.hoisted().
  const create = vi.fn();
  function fakeClient() {
    return { chat: { completions: { create } } } as any;
  }
  return {
    create,
    fakeClient,
    chain: [
      {
        client: fakeClient(),
        model: "test-model",
        name: "Test",
        endpoint: "https://test.example.com/v1",
        maxIterations: 4,
      },
    ],
  };
});

const { create, fakeClient, chain: llmChain } = hoisted;

const prismaMocks = vi.hoisted(() => ({
  reviewRunFindFirst: vi.fn(),
  pullRequestFindUnique: vi.fn(),
  pullRequestUpdateMany: vi.fn(),
  reviewRunUpdate: vi.fn(),
  reviewRunFindUnique: vi.fn(),
  completeReviewRun: vi.fn(),
}));

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: () => llmChain,
  getChatClient: () => (llmChain.length > 0 ? llmChain[0].client : null),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: prismaMocks.pullRequestFindUnique,
      updateMany: prismaMocks.pullRequestUpdateMany,
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({ id: "repo-1", path: null, localPath: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findFirst: prismaMocks.reviewRunFindFirst,
      findUnique: prismaMocks.reviewRunFindUnique,
      update: prismaMocks.reviewRunUpdate,
    },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewFinding: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
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

describe("ReviewRun.outcome persistence — issue #19", () => {
  beforeEach(() => {
    create.mockClear();
    prismaMocks.reviewRunFindFirst.mockReset().mockResolvedValue(null);
    prismaMocks.pullRequestFindUnique.mockReset().mockResolvedValue({
      id: "pr-1",
      repoId: "repo-1",
      title: "Test PR",
      description: "test",
      sourceBranch: "feature/test",
      commitHash: "abc123",
    });
    prismaMocks.pullRequestUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMocks.reviewRunUpdate.mockReset().mockResolvedValue({});
    prismaMocks.reviewRunFindUnique.mockReset().mockResolvedValue({
      id: "run-1",
      status: "in_progress",
    });
    prismaMocks.completeReviewRun.mockReset().mockResolvedValue(undefined);
  });

  it("trivial-skip path writes outcome='skipped' via prisma.reviewRun.update", async () => {
    // Trivial-skip uses a DIRECT prisma.reviewRun.update (not completeReviewRun)
    // because it short-circuits before the success terminal. See reviewService.ts
    // ~line 1907 for the write site.
    const { runPrScan } = await import("../src/services/reviewService");

    // Files: all trivial (README.md matches docs pattern in diffClassifier.ts).
    // Pass a reviewRunId so the trivial-skip path's `if (reviewRunId && !reviewChunkId)`
    // gate fires and the direct prisma.reviewRun.update at reviewService.ts:1907 runs.
    await runPrScan(
      "pr-1",
      [
        {
          filename: "README.md",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "# Updated docs\n",
          diff: "+# Updated docs\n",
        },
      ],
      "run-skip",
    );

    // The trivial-skip path writes via prisma.reviewRun.update with
    // outcome="skipped" (the direct write, NOT via completeReviewRun).
    const skipUpdateCall = prismaMocks.reviewRunUpdate.mock.calls.find(
      (c: any[]) => c[0]?.data?.outcome === "skipped",
    );
    expect(skipUpdateCall).toBeDefined();
    expect(skipUpdateCall?.[0]?.data).toMatchObject({
      status: "completed",
      outcome: "skipped",
      rating: null,
    });

    // completeReviewRun is NOT called for the trivial-skip path — the
    // direct prisma.reviewRun.update at reviewService.ts:1907 is the
    // sole terminal write. Assert no "reviewed" outcome slipped in.
    const reviewedCalls = prismaMocks.completeReviewRun.mock.calls.filter(
      (c: any[]) => c[1]?.outcome === "reviewed",
    );
    expect(reviewedCalls).toHaveLength(0);
  });

  it("successful-review path writes outcome='reviewed' via completeReviewRun", async () => {
    // Drive runPrScan with a real code file + stub the LLM to produce a
    // valid submitReview tool call carrying a rating. Mirrors the mock
    // posture of reviewServiceFallbackRegression.test.ts but with a
    // successful tool-call instead of loop exhaustion.
    create.mockImplementation(async (body: any) => {
      if (body?.tools) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-submit",
                    type: "function",
                    function: {
                      name: "submitReview",
                      arguments: JSON.stringify({
                        rating: 9,
                        summary: "Looks good.",
                        findings: [],
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        };
      }
      // Finalizer (no tools) — not reached when submitReview fires on
      // iteration 1, but provide a fallback to keep the test robust.
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({ rating: 9, summary: "ok", findings: [] }),
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      };
    });

    const { runPrScan } = await import("../src/services/reviewService");

    const result = await runPrScan(
      "pr-1",
      [
        {
          filename: "src/foo.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "export const x = 1;\n",
          modifiedContent: "export const x = 2;\n",
          diff: "-export const x = 1;\n+export const x = 2;\n",
        },
      ],
      "run-success",
    );

    expect(result.success).toBe(true);
    expect(result.rating).toBe(9);

    // Success terminal calls completeReviewRun with outcome="reviewed".
    const successCall = prismaMocks.completeReviewRun.mock.calls.find(
      (c: any[]) => c[1]?.status === "completed" && c[1]?.outcome === "reviewed",
    );
    expect(successCall).toBeDefined();
    expect(successCall?.[1]).toMatchObject({
      status: "completed",
      rating: 9,
      outcome: "reviewed",
    });
  });

  it("failure path leaves outcome field absent (not 'reviewed' or 'skipped')", async () => {
    // Empty chat chain — runPrScan's LLM step returns a StepError
    // ("no provider configured"). With no critical step producing
    // LLM data, line 1884-1895 returns success=false WITHOUT calling
    // completeReviewRun with status="completed". The run row is left
    // for the outer route's catch block to mark failed. Assert: no
    // completeReviewRun call carries outcome="reviewed" or "skipped".
    const savedChain = llmChain.slice();
    llmChain.length = 0;

    const { runPrScan } = await import("../src/services/reviewService");

    const result = await runPrScan(
      "pr-1",
      [
        {
          filename: "src/foo.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "export const x = 1;\n",
          diff: "+export const x = 1;\n",
        },
      ],
      "run-fail",
    );

    expect(result.success).toBe(false);

    // The success terminal's completeReviewRun call must NOT have fired.
    // (The route layer's catch block owns the status="failed" write —
    // see scan/route.ts:470. Service-layer failure paths either return
    // early without calling completeReviewRun, or call it with status="failed"
    // and no outcome field.)
    const reviewedCalls = prismaMocks.completeReviewRun.mock.calls.filter(
      (c: any[]) => c[1]?.outcome === "reviewed",
    );
    const skippedCalls = prismaMocks.completeReviewRun.mock.calls.filter(
      (c: any[]) => c[1]?.outcome === "skipped",
    );
    expect(reviewedCalls).toHaveLength(0);
    expect(skippedCalls).toHaveLength(0);

    // Also assert the direct prisma.reviewRun.update skip write didn't fire.
    const skipUpdateCalls = prismaMocks.reviewRunUpdate.mock.calls.filter(
      (c: any[]) => c[0]?.data?.outcome === "skipped",
    );
    expect(skipUpdateCalls).toHaveLength(0);

    // Restore chain for subsequent tests.
    llmChain.push(...savedChain);
  });

  it("empty-diff no-prior-cache path writes outcome='reviewed' via completeReviewRun", async () => {
    // No files, no prior completed rating — the fallback that creates
    // a fresh "no code changes" run with rating=null. Per spec, this
    // path is marked outcome="reviewed" (NOT skipped — skipped is
    // reserved for trivial-skip, where the diff HAS files but they're
    // all config/docs/generated).
    const { runPrScan } = await import("../src/services/reviewService");

    await runPrScan("pr-1", undefined, "run-empty");

    expect(prismaMocks.completeReviewRun).toHaveBeenCalledWith("run-empty", {
      status: "completed",
      rating: null,
      refused: false,
      outcome: "reviewed",
    });
  });
});
