import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Integration: when the agentic loop is nearly out of iterations and
 * has not called submitReview, the finish path must force tool_choice
 * toward submitReview (and nudge). JSON finalizer remains the backup.
 *
 * Issue #138 — budget nearly exhausted without submit forces finish path.
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
      name: "Primary",
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
        id: "pr-1",
        repoId: "repo-1",
        title: "Test PR",
        description: "test",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    repository: {
      findUnique: vi.fn().mockResolvedValue({ id: "repo-1", path: null, localPath: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: vi.fn().mockResolvedValue([]) },
    symbol: { findMany: vi.fn().mockResolvedValue([]) },
    edge: { findMany: vi.fn().mockResolvedValue([]) },
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({ id: "run-1", status: "in_progress" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
    reviewFinding: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks: vi.fn().mockResolvedValue([]),
  logReview: vi.fn().mockResolvedValue(undefined),
  shouldRunHostTier1: () => false,
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

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${name}-${Math.random().toString(36).slice(2)}`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function finalizerJunk() {
  return {
    choices: [{ message: { role: "assistant", content: "not a review" } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const codeFile = {
  filename: "src/test.ts",
  status: "modified" as const,
  additions: 1,
  deletions: 1,
  originalContent: "",
  modifiedContent: "export const x = 1;\n",
  diff: "+export const x = 1;\n",
};

describe("agentic finish path — budget nearly exhausted", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("forces tool_choice submitReview on the last iteration when no submit yet", async () => {
    // Iterations 1–3: burn budget on searchCodebase. Iteration 4 must be
    // finish path (forced submitReview). Then finalizer if still empty.
    let mainLoopCalls = 0;
    create.mockImplementation(async (body: any) => {
      if (body?.tools) {
        mainLoopCalls++;
        if (mainLoopCalls < 4) {
          return toolCallResponse("searchCodebase", { query: "x" });
        }
        // Finish path: model finally submits when forced.
        return toolCallResponse("submitReview", {
          rating: 7,
          summary: "Forced finish.",
          findings: [],
        });
      }
      return finalizerJunk();
    });

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", [codeFile]);

    expect(result.success).toBe(true);
    expect(result.rating).toBe(7);

    const mainCalls = create.mock.calls
      .map((c) => c[0])
      .filter((body: any) => body?.tools);

    expect(mainCalls.length).toBe(4);

    // First three: auto
    for (let i = 0; i < 3; i++) {
      expect(mainCalls[i].tool_choice).toBe("auto");
    }
    // Last: forced finish path
    expect(mainCalls[3].tool_choice).toEqual({
      type: "function",
      function: { name: "submitReview" },
    });

    // Nudge present in messages on the finish call
    const finishMessages = mainCalls[3].messages as Array<{ role: string; content?: string }>;
    const nudge = finishMessages.find(
      (m) => m.role === "user" && typeof m.content === "string" && /submitReview NOW/i.test(m.content),
    );
    expect(nudge).toBeDefined();
  });

  it("invalid submitReview shape stays retryable with warn (does not accept)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    create.mockImplementation(async (body: any) => {
      if (body?.tools) {
        // Always return malformed submitReview
        return toolCallResponse("submitReview", { summary: "missing rating and findings" });
      }
      return finalizerJunk();
    });

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", [codeFile]);

    expect(result.success).toBe(false);

    const invalidShapeWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && /submitReview had invalid shape/.test(c[0]),
    );
    expect(invalidShapeWarns.length).toBeGreaterThan(0);

    // Multiple main-loop attempts (retryable), not a hard abort on first bad shape
    const mainCalls = create.mock.calls.filter((c) => c[0]?.tools);
    expect(mainCalls.length).toBeGreaterThanOrEqual(2);

    warnSpy.mockRestore();
  });

  it("end-of-attempt log includes iterations, submitReview, finalizerAttempted", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    create.mockImplementation(async (body: any) => {
      if (body?.tools) {
        return toolCallResponse("searchCodebase", { query: "burn" });
      }
      return finalizerJunk();
    });

    const { runPrScan } = await import("../src/services/reviewService");
    await runPrScan("pr-1", [codeFile]);

    const endLines = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => /provider Primary outcome=/.test(line));

    expect(endLines.length).toBeGreaterThanOrEqual(1);
    const line = endLines[endLines.length - 1];
    expect(line).toMatch(/iterations=\d+\/4/);
    expect(line).toMatch(/submitReview=false/);
    expect(line).toMatch(/finalizerAttempted=true/);
    expect(line).toMatch(/malformed=\d+/);

    logSpy.mockRestore();
  });
});
