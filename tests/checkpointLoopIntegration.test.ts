import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 6 — verify runPrScan's loop actually writes per-iteration
 * checkpoints and clears them on success.
 *
 * The repository mock returns a real tmp directory as `localPath` so
 * the checkpoint store writes to disk. We assert:
 *   - After iteration 1: `__run.json` exists with loopCount=1
 *   - After iteration 2 + submitReview: file still exists (pre-success)
 *   - After runPrScan returns success: file is deleted
 *
 * Mock posture mirrors scanAbortIntegration.test.ts.
 */

const create = vi.fn();
let tmpRepo: string;

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
        id: "pr-cp",
        repoId: "repo-cp",
        title: "Checkpoint PR",
        description: "test",
        sourceBranch: "feat",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repository: {
      // localPath=tmpRepo is set per-test via a getter so each test
      // gets a fresh directory without re-mocking the module.
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: "repo-cp",
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
      findUnique: vi.fn().mockResolvedValue({ id: "run-cp", status: "in_progress" }),
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

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue(new Map()),
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

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-cploop-"));
  create.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

function checkpointPath(): string {
  return path.join(tmpRepo, ".dragnet", "checkpoints", "run-cp", "__run.json");
}

describe("Phase 6 — loop writes and clears checkpoints", () => {
  it("writes a checkpoint per iteration, then deletes on success", async () => {
    // First iteration: tool call (searchCodebase → empty). Second
    // iteration: submitReview with a valid rating. The loop should
    // write a checkpoint after each iteration, then clear on success.
    let callIdx = 0;
    create.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          choices: [{
            message: {
              role: "assistant",
              content: "thinking",
              tool_calls: [{
                id: "call-1",
                function: { name: "searchCodebase", arguments: '{"query":"x"}' },
              }],
            },
          }],
          usage: null,
        });
      }
      // Second call: submitReview.
      return Promise.resolve({
        choices: [{
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [{
              id: "call-2",
              function: {
                name: "submitReview",
                arguments: JSON.stringify({
                  rating: 8,
                  summary: "good",
                  findings: [],
                }),
              },
            }],
          },
        }],
        usage: null,
      });
    });

    const { runPrScan } = await import("../reviewService");
    const result = await runPrScan(
      "pr-cp",
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
      "run-cp",
      undefined,
      undefined,
      {
        checkpointMetadata: {
          commitHash: "abc",
          diffHash: "def",
          reviewConfigHash: "ghi",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.rating).toBe(8);
    // After success, the checkpoint file MUST be gone.
    expect(fs.existsSync(checkpointPath())).toBe(false);
  });

  it("keeps the checkpoint when scan is interrupted mid-iteration", async () => {
    // First iteration succeeds with a tool call → checkpoint written.
    // Second iteration's LLM call aborts → outer catch returns
    // interrupted result WITHOUT clearing the checkpoint.
    let callIdx = 0;
    create.mockImplementation((_body: any, opts?: { signal?: AbortSignal }) => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          choices: [{
            message: {
              role: "assistant",
              content: "thinking",
              tool_calls: [{
                id: "call-1",
                function: { name: "searchCodebase", arguments: '{"query":"x"}' },
              }],
            },
          }],
          usage: null,
        });
      }
      // Second call: simulate abort.
      return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        const err: any = new Error("aborted");
        err.name = "AbortError";
        if (signal?.aborted) {
          reject(err);
          return;
        }
        signal?.addEventListener("abort", () => reject(err));
      });
    });

    const controller = new AbortController();
    const { runPrScan } = await import("../reviewService");

    const scanPromise = runPrScan(
      "pr-cp",
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
      "run-cp",
      undefined,
      undefined,
      {
        signal: controller.signal,
        checkpointMetadata: {
          commitHash: "abc",
          diffHash: "def",
          reviewConfigHash: "ghi",
        },
      },
    );

    // Let iteration 1 complete + checkpoint write, then iteration 2
    // enter create() before we abort.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    controller.abort();

    const result = await scanPromise;

    expect(result.interrupted).toBe(true);
    // The checkpoint from iteration 1 MUST persist so Phase 7 resume
    // can pick it up.
    expect(fs.existsSync(checkpointPath())).toBe(true);

    // Verify the checkpoint content — should have loopCount=1 and the
    // hash trio.
    const raw = fs.readFileSync(checkpointPath(), "utf8");
    const cp = JSON.parse(raw);
    expect(cp.loopCount).toBe(1);
    expect(cp.runId).toBe("run-cp");
    expect(cp.checkpointId).toBe("__run");
    expect(cp.commitHash).toBe("abc");
    expect(cp.diffHash).toBe("def");
    expect(cp.reviewConfigHash).toBe("ghi");
    expect(cp.model).toBe("test-model");
    expect(cp.provider).toBe("https://test.example.com/v1");
  });

  it("does not write checkpoints when checkpointMetadata is absent", async () => {
    // Legacy callers (prepush, prcheck, command) don't pass metadata.
    // runPrScan must skip the checkpoint write entirely — no orphan
    // files, no lastCheckpointAt stamp.
    create.mockImplementation(() => {
      return Promise.resolve({
        choices: [{
          message: {
            role: "assistant",
            content: "done",
            tool_calls: [{
              id: "call-1",
              function: {
                name: "submitReview",
                arguments: JSON.stringify({
                  rating: 9,
                  summary: "clean",
                  findings: [],
                }),
              },
            }],
          },
        }],
        usage: null,
      });
    });

    const { runPrScan } = await import("../reviewService");
    await runPrScan(
      "pr-cp",
      [
        {
          filename: "src/test.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          originalContent: "",
          modifiedContent: "x",
          diff: "+x",
        },
      ],
      "run-cp",
      // No options.checkpointMetadata
    );

    expect(fs.existsSync(checkpointPath())).toBe(false);
    // The checkpoints directory itself shouldn't exist either.
    expect(fs.existsSync(path.join(tmpRepo, ".dragnet", "checkpoints"))).toBe(false);
  });
});
