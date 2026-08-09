import { describe, expect, it, vi, beforeEach } from "vitest";
import { writeCheckpoint } from "../src/services/checkpointStore";

/**
 * Issue #139 — primary quality_failure tries secondary, then hard-fail.
 *
 * Policy change from transport-only fallback:
 *   - Primary quality_failure (loop exhausted / no usable submitReview)
 *     → run secondary with the same agentic contract when configured
 *   - Secondary success is the published review; chain logged
 *   - Both fail → hard_fail (success=false, rating null, no fabricated AI findings)
 *   - Transport failures still fall through as before
 */

const primaryCreate = vi.fn();
const secondaryCreate = vi.fn();

function fakeClient(createFn: ReturnType<typeof vi.fn>) {
  return {
    chat: {
      completions: {
        create: createFn,
      },
    },
  } as any;
}

const hoisted = vi.hoisted(() => ({
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: () => [
    {
      client: fakeClient(primaryCreate),
      model: "primary-model",
      name: "Primary",
      endpoint: "https://primary.example.com/v1",
      maxIterations: 4,
    },
    {
      client: fakeClient(secondaryCreate),
      model: "secondary-model",
      name: "Secondary",
      endpoint: "https://secondary.example.com/v1",
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
        sourceBranch: "feature",
        commitHash: "abc123",
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
  logReview: hoisted.logReview,
  shouldRunHostTier1: () => false,
  DEFAULT_INSTALL_COMMAND: "npm install",
  DEFAULT_TEST_COMMAND: "npm run typecheck && npm run lint",
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockImplementation(async (_prId: string, findings: any[]) => findings),
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
  resolveSymbolsBatch: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
  dedupFindingsWithinRun: vi.fn().mockResolvedValue(0),
}));

/** Tool-loop burn: searchCodebase forever; finalizer returns unparseable text. */
function qualityFailResponse(body: any) {
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  return {
    choices: [{ message: { role: "assistant", content: "I cannot produce a review." } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function submitReviewResponse(rating: number, findings: any[] = []) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `submit-${Math.random().toString(36).slice(2)}`,
              type: "function",
              function: {
                name: "submitReview",
                arguments: JSON.stringify({
                  rating,
                  summary: `Secondary review rating ${rating}`,
                  findings,
                }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const sampleFiles = [
  {
    filename: "src/test.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    originalContent: "",
    modifiedContent: "export const x = 1;\n",
    diff: "+export const x = 1;\n",
  },
];

describe("runPrScan quality_failure provider chain (#139)", () => {
  beforeEach(() => {
    primaryCreate.mockClear();
    secondaryCreate.mockClear();
    hoisted.logReview.mockClear();
  });

  it("primary quality_failure → secondary submitReview is the published review", async () => {
    primaryCreate.mockImplementation((body: any) => Promise.resolve(qualityFailResponse(body)));
    secondaryCreate.mockImplementation((body: any) => {
      if (body?.tools) {
        return Promise.resolve(submitReviewResponse(8));
      }
      // Refusal-check / other no-tools calls
      return Promise.resolve({
        choices: [{ message: { role: "assistant", content: '{"refused": false, "topics": []}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", sampleFiles);

    expect(secondaryCreate).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.usedModel).toBe("secondary-model");
    // No fabricated AI findings on the success path either — empty findings is honest
    expect(result.findings.filter((f: any) => f.source === "llm" && !f.explanation)).toEqual([]);

    const logMsgs = hoisted.logReview.mock.calls.map((c: any[]) => String(c[1] ?? ""));
    expect(logMsgs.some((m) => /fallback-after-quality-failure/i.test(m))).toBe(true);
  });

  it("continues the LLM review after an external dependency skip", async () => {
    primaryCreate.mockImplementation((body: any) => {
      if (body?.tools) return Promise.resolve(submitReviewResponse(8));
      return Promise.resolve({
        choices: [{ message: { role: "assistant", content: '{"refused": false, "topics": []}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", sampleFiles, undefined, undefined, undefined, {
      precomputedFindings: [{
        filename: "<tooling>",
        line: null,
        severity: "info",
        category: "External Dependency Skipped",
        explanation: "[runner] External dependency unavailable while running npm test",
        source: "runner",
      }],
    });

    expect(primaryCreate).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "External Dependency Skipped", source: "runner" }),
    ]));
  });

  it("both providers quality_failure → hard_fail, null rating, no fabricated AI findings", async () => {
    primaryCreate.mockImplementation((body: any) => Promise.resolve(qualityFailResponse(body)));
    secondaryCreate.mockImplementation((body: any) => Promise.resolve(qualityFailResponse(body)));

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", sampleFiles);

    expect(primaryCreate).toHaveBeenCalled();
    expect(secondaryCreate).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.rating).toBeNull();
    // No invented LLM findings — only deterministic (none in this mock)
    expect(result.findings.filter((f: any) => f.source === "llm")).toEqual([]);
    expect(result.systemWarn ?? "").toMatch(/hard_fail|without calling submitReview|quality/i);
  });

  it("transport failure on primary still falls through to secondary", async () => {
    const rateLimitErr: any = new Error("429 rate limit exceeded");
    rateLimitErr.status = 429;
    primaryCreate.mockRejectedValue(rateLimitErr);
    secondaryCreate.mockImplementation((body: any) => {
      if (body?.tools) {
        return Promise.resolve(submitReviewResponse(7));
      }
      return Promise.resolve({
        choices: [{ message: { role: "assistant", content: '{"refused": false, "topics": []}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan("pr-1", sampleFiles);

    expect(secondaryCreate).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.rating).toBe(7);
  });

  it("resumes a timed-out provider from the latest checkpoint", async () => {
    const timeout: any = new Error("provider timed out");
    timeout.code = "ETIMEDOUT";
    primaryCreate.mockRejectedValue(timeout);
    secondaryCreate.mockImplementation((body: any) => {
      if (body?.tools) return Promise.resolve(submitReviewResponse(8));
      return Promise.resolve({
        choices: [{ message: { role: "assistant", content: '{"refused": false, "topics": []}' } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
    });
    process.env.DRAGNET_SCAN_STATE_ROOT = "/tmp/dragnet-review-service-fallback-tests";
    writeCheckpoint("", "run-1", "__run", {
      version: 1,
      runId: "run-1",
      checkpointId: "__run",
      commitHash: "abc123",
      diffHash: "diff-hash",
      reviewConfigHash: "config-hash",
      messages: [
        { role: "system", content: "prior system" },
        { role: "user", content: "prior prompt" },
        { role: "assistant", content: "prior investigation", tool_calls: [] },
      ],
      loopCount: 1,
      maxIterations: 4,
      provider: "Primary",
      model: "primary-model",
      writtenAt: Date.now(),
    }, "repo-1");

    const { runPrScan } = await import("../src/services/reviewService");
    const result = await runPrScan(
      "pr-1",
      sampleFiles,
      "run-1",
      undefined,
      undefined,
      { checkpointMetadata: { commitHash: "abc123", diffHash: "diff-hash", reviewConfigHash: "config-hash" } },
    );

    expect(result.success).toBe(true);
    const resumedMessages = secondaryCreate.mock.calls[0][0].messages;
    expect(resumedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "prior investigation" }),
    ]));
    expect(hoisted.logReview.mock.calls.some((call: any[]) => /Resuming fallback provider/.test(String(call[1])))).toBe(true);
  });

  it("treats an abandoned running provider attempt as interrupted for fallback", async () => {
    const { recoveredProviderOutcome } = await import("../src/services/reviewService");
    expect(recoveredProviderOutcome({ status: "running", outcome: null })).toBe("interrupted");
    expect(recoveredProviderOutcome({ status: "failed", outcome: "transport_failure" })).toBe("transport_failure");
  });
});
