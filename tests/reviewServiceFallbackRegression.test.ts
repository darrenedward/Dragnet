import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression test for spec phase 1, task 1.8:
 *   "NVIDIA hits 4/4 iterations without submitReview; Minimax MUST NOT
 *   be invoked in that scan."
 *
 * Phase 1 wires classifier output into `providerAttempts[]` as a
 * parallel signal, but the fallback DECISION still keys off
 * `isRetryableProviderFailure(err)`. This test proves the existing
 * transport-only fallback semantics are preserved: when the primary
 * provider runs cleanly but burns its iteration budget without ever
 * calling submitReview (a model-quality failure, not a transport
 * failure), the chain stops — fallback is NOT invoked.
 *
 * Mock posture mirrors `tests/embeddingGuard.test.ts`:
 *   vi.mock("../src/lib/llmClient", ...) injects a fake chain.
 */

// Counters inspected by assertions.
const nvidiaCreate = vi.fn();
const minimaxCreate = vi.fn();

// Build a fake OpenAI-shaped client. reviewService.ts calls
// `client.chat.completions.create(body, options)` — only the create
// method needs to behave like a Promise-returning function.
function fakeClient(createFn: ReturnType<typeof vi.fn>) {
  return {
    chat: {
      completions: {
        create: createFn,
      },
    },
  } as any;
}

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: () => [
    {
      client: fakeClient(nvidiaCreate),
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      name: "NVIDIA",
      endpoint: "https://nvidia.example.com/v1",
      maxIterations: 4,
    },
    {
      client: fakeClient(minimaxCreate),
      model: "minimax/MiniMAX-M1",
      name: "Minimax",
      endpoint: "https://minimax.example.com/v1",
      maxIterations: 4,
    },
  ],
  getChatClient: () => null,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: "pr-1",
        repoId: "repo-1",
        title: "Test PR",
        description: "test",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      // path/localPath both null so runDeterministicChecks is skipped.
      findUnique: vi.fn().mockResolvedValue({ id: "repo-1", path: null, localPath: null }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    // searchCodebase tool queries these — return empty so the tool
    // produces a "No results." response.
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

// Skip deterministic checks (would otherwise shell out to tsc/eslint).
vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks: vi.fn().mockResolvedValue([]),
  logReview: vi.fn().mockResolvedValue(undefined),
}));

// Stub post-loop verifier — we're testing the loop, not the verifier.
vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue([]),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

// Stub review-run completion helpers.
vi.mock("../src/lib/reviewFreshness", () => ({
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
  setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
  setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
}));

// Stub reconcile/fingerprint helpers used post-loop.
vi.mock("../src/services/largePrReview/fingerprint", () => ({
  buildFindingFingerprint: vi.fn().mockReturnValue("fp"),
  resolveSymbolsBatch: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
}));

/**
 * NVIDIA mock: always returns a searchCodebase tool call. Consumes
 * iterations but never produces submitReview. After the main loop
 * exhausts, the JSON finalizer path is invoked — those calls have
 * `response_format: { type: "json_object" }` OR no tools in the
 * body. We return content that won't parse as a valid review, so
 * finalReview stays null.
 */
function nvidiaResponse(body: any) {
  // Main-loop call has `tools` in the body.
  if (body?.tools) {
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${Math.random().toString(36).slice(2)}`,
                type: "function",
                function: {
                  name: "searchCodebase",
                  arguments: JSON.stringify({ query: "never-matches" }),
                },
              },
            ],
          },
        },
      ],
    };
  }
  // Finalizer call (no tools) — return text that won't parse as a
  // valid review JSON shape.
  return {
    choices: [{ message: { role: "assistant", content: "I cannot produce a review." } }],
  };
}

describe("runPrScan fallback regression — NVIDIA 4/4 must not invoke Minimax", () => {
  beforeEach(() => {
    nvidiaCreate.mockClear();
    minimaxCreate.mockClear();
    nvidiaCreate.mockImplementation((body: any) => Promise.resolve(nvidiaResponse(body)));
  });

  it("primary provider loop exhaustion does NOT fall through to next provider", async () => {
    const { runPrScan } = await import("../reviewService");

    // runPrScan throws when no provider produces a review (line 1176).
    // That throw is incidental to what we're testing — the load-bearing
    // assertion is that Minimax was never invoked. We expect the
    // reject, then check call counts.
    await expect(
      runPrScan("pr-1", [
        {
          filename: "src/test.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "export const x = 1;\n",
          diff: "+export const x = 1;\n",
        },
      ]),
    ).rejects.toThrow(/ended the agentic loop without calling submitReview/);

    // Minimax must never have been invoked. This is the regression
    // assertion: a model-quality failure on the primary MUST NOT fall
    // through to the fallback provider.
    expect(minimaxCreate).not.toHaveBeenCalled();

    // NVIDIA's main loop ran the full iteration budget before bailing.
    // 4 main-loop calls + at least 1 JSON finalizer call.
    expect(nvidiaCreate.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
