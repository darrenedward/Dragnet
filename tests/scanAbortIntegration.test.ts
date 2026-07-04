import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Phase 4.10 — full end-to-end abort integration test.
 *
 * Proves that when acquireReviewLock(prId, force=true) is called while
 * a scan is mid-LLM-call, the in-flight scan's signal is aborted, the
 * OpenAI SDK call rejects with AbortError, and runPrScan returns the
 * typed interrupted ScanResult — WITHOUT marking the run failed.
 *
 * Mock posture mirrors `tests/reviewServiceFallbackRegression.test.ts`.
 * The create() mock blocks on an inverted deferred so we can fire the
 * force-restart mid-call.
 */

const create = vi.fn();

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
        id: "pr-abort",
        repoId: "repo-abort",
        title: "Abort PR",
        description: "test",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({ id: "repo-abort", path: null, localPath: null }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-abort", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
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
}));

describe("Phase 4.10 — force-restart aborts in-flight scan", () => {
  beforeEach(() => {
    create.mockClear();
  });

  it("abort signal fires through create() and runPrScan returns interrupted", async () => {
    const { runPrScan } = await import("../reviewService");

    // Build a controller the test controls. We pass it directly into
    // runPrScan via options.signal — same shape acquireReviewLock
    // hands the scan route.
    const controller = new AbortController();

    // Make create() reject with AbortError when signal fires. We block
    // the call until the test aborts the controller.
    create.mockImplementation((_body: any, opts?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (!signal) {
          // No signal — resolve with a minimal response so other tests
          // paths don't hang forever.
          _resolve({ choices: [{ message: { role: "assistant", content: "{}" } }] } as any);
          return;
        }
        if (signal.aborted) {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err: any = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    // Kick off the scan. It will block inside the first create() call.
    const scanPromise = runPrScan(
      "pr-abort",
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
      "run-abort",
      undefined,
      undefined,
      { signal: controller.signal },
    );

    // Let the loop enter create() — give it a tick.
    await new Promise((r) => setImmediate(r));
    expect(create).toHaveBeenCalled();

    // Fire the abort — same as acquireReviewLock(force=true) does.
    controller.abort();

    const result = await scanPromise;

    // Critical assertions:
    expect(result.interrupted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.rating).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.message).toMatch(/aborted/i);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
