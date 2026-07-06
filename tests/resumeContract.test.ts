import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Phase 7 — verify the resume contract end-to-end:
 *
 *  1. inspectStaleRun picks the run-level __run checkpoint over chunk ones.
 *  2. assertNoActiveScan returns stale_inspectable when a checkpoint exists.
 *  3. assertNoActiveScan reaps (returns ok) when stale run has NO checkpoint.
 *  4. The scan route's resume path rejects on commit/diff change.
 *  5. The scan route's resume path rejects on reviewConfigHash change.
 *
 * The scan route itself is exercised via a focused subtest that drives
 * the GET path returning `status: "interrupted"` and the POST ?resume=true
 * path validating the checkpoint's hash trio.
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
  getEmbeddingChain: () => [
    {
      client: fakeClient(),
      model: "embed-model",
      name: "Embed",
      endpoint: "https://embed.example.com/v1",
    },
  ],
  getPrimaryChatPreset: () => null,
}));

vi.mock("../src/lib/prisma", () => {
  // In-memory reviewRun rows so tests can mutate state without DB.
  const runs = new Map<string, any>();
  return {
    prisma: {
      pullRequest: {
        findUnique: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve({
            id: where.id,
            repoId: "repo-resume",
            sourceBranch: "feat",
            targetBranch: "main",
            commitHash: "commit-current",
          }),
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      repository: {
        findUnique: vi.fn().mockImplementation(() =>
          Promise.resolve({
            id: "repo-resume",
            name: "resume-repo",
            path: tmpRepo,
            localPath: null,
            indexedAt: "2026-07-01",
            lastCommitHash: "x",
            baseBranch: "main",
            securitySensitivePaths: [],
          }),
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prFile: {
        findMany: vi.fn().mockResolvedValue([
          {
            filename: "src/test.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            diff: "+x",
            modifiedContent: "x",
            originalContent: "",
          },
        ]),
      },
      symbol: { findMany: vi.fn().mockResolvedValue([]) },
      edge: { findMany: vi.fn().mockResolvedValue([]) },
      reviewRun: {
        findFirst: vi.fn().mockImplementation(({ where, orderBy }) => {
          const matches = Array.from(runs.values()).filter((r) => r.prId === where?.prId && r.status === where?.status);
          if (matches.length === 0) return Promise.resolve(null);
          matches.sort((a, b) => (orderBy?.startedAt === "desc" ? b.startedAt.getTime() - a.startedAt.getTime() : 0));
          return Promise.resolve(matches[0]);
        }),
        findUnique: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve(runs.get(where.id) ?? null),
        ),
        update: vi.fn().mockImplementation(({ where, data }) => {
          const r = runs.get(where.id);
          if (r) Object.assign(r, data);
          return Promise.resolve(r);
        }),
        create: vi.fn().mockImplementation(({ data }) => {
          const id = data.id ?? `run-${runs.size + 1}`;
          runs.set(id, { ...data, id });
          return Promise.resolve(runs.get(id));
        }),
      },
      reviewFinding: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      reviewLog: { create: vi.fn().mockResolvedValue({}) },
      reviewHistory: { create: vi.fn().mockResolvedValue({}) },
      __resetRuns: () => runs.clear(),
      __seedRun: (r: any) => runs.set(r.id, r),
    },
  };
});

vi.mock("../src/services/deterministicChecks", () => ({
  runDeterministicChecks: vi.fn().mockResolvedValue([]),
  runContainerizedChecks: vi.fn().mockResolvedValue([]),
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/findingVerifier", () => ({
  verifyFindings: vi.fn().mockResolvedValue(new Map()),
  isDocumentationFile: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/lib/reviewFreshness", async (importOriginal) => {
  // The real assertNoActiveScan lives here — we WANT to test it, so the
  // mock re-exports the actual implementation via importOriginal. Other
  // helpers stay stubbed so the scan route doesn't try to hit DB paths
  // we're not exercising here.
  const actual = await importOriginal<typeof import("../src/lib/reviewFreshness")>();
  return {
    ...actual,
    completeReviewRun: vi.fn().mockResolvedValue(undefined),
    setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
    setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
    setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
    createReviewRun: vi.fn().mockResolvedValue("run-new"),
    assertReviewFreshness: vi.fn().mockResolvedValue({ ok: false, kind: "NO_RUN", message: "" }),
    computeDiffHash: vi.fn().mockReturnValue("diff-current"),
    computeReviewConfigHash: vi.fn().mockReturnValue("config-current"),
    shortHash: vi.fn().mockReturnValue("sys-hash"),
  };
});

vi.mock("../src/services/largePrReview/fingerprint", () => ({
  buildFindingFingerprint: vi.fn().mockReturnValue("fp"),
  resolveSymbolsBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/largePrReview/reconcile", () => ({
  reconcileFindingsAcrossRuns: vi.fn().mockResolvedValue([]),
  dedupFindingsWithinRun: vi.fn().mockResolvedValue(0),
}));

vi.mock("../src/lib/apiAuth", () => ({
  authenticateSessionOrKey: vi.fn().mockResolvedValue({ ok: true }),
  enforcePrRepoScope: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/lib/indexFreshness", () => ({
  assertIndexFresh: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("../src/lib/getRealLocalPrs", () => ({
  refreshPrFiles: vi.fn().mockResolvedValue([
    {
      filename: "src/test.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      diff: "+x",
      modifiedContent: "x",
      originalContent: "",
    },
  ]),
  isBranchMerged: vi.fn().mockResolvedValue(false),
}));

vi.mock("../src/services/indexingService", () => ({
  IndexingService: { indexFolder: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../src/lib/prSizeProfile", () => ({
  computePrSizeProfile: vi.fn().mockReturnValue({ commitCount: 1, codeLines: 1 }),
}));

vi.mock("../src/lib/prSizeProfile.server", () => ({
  readPrCommitCount: vi.fn().mockReturnValue(1),
}));

vi.mock("../src/services/largePrReview", () => ({
  assertTier: vi.fn().mockReturnValue({ tier: "normal" }),
  buildDiffManifest: vi.fn().mockReturnValue({ codeLines: 1, codeFiles: 1 }),
}));

vi.mock("../src/lib/prSizeConfig", () => ({
  readLimits: vi.fn().mockReturnValue({
    chunkLineCap: 500,
    minUsefulChunkLines: 50,
    normalMaxLines: 1000,
    normalMaxCodeFiles: 20,
    oversizedLines: 2000,
    oversizedCodeFiles: 50,
    maxFilesPerReview: 0,
  }),
}));

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-resume-"));
  create.mockClear();
  // Seed a normal submitReview response so any runPrScan call succeeds.
  create.mockImplementation(() =>
    Promise.resolve({
      choices: [{
        message: {
          role: "assistant",
          content: "done",
          tool_calls: [{
            id: "call-1",
            function: {
              name: "submitReview",
              arguments: JSON.stringify({ rating: 9, summary: "ok", findings: [] }),
            },
          }],
        },
      }],
      usage: null,
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

async function seedStaleRun(opts: {
  runId?: string;
  commitHash?: string;
  diffHash?: string;
  reviewConfigHash?: string;
  startedAgoMs?: number;
} = {}) {
  const runId = opts.runId ?? "run-stale";
  const startedAt = new Date(Date.now() - (opts.startedAgoMs ?? 10 * 60 * 1000));
  // Bypass the createReviewRun mock by writing directly to the in-memory store.
  const { prisma } = await import("../src/lib/prisma") as any;
  (prisma as any).__seedRun({
    id: runId,
    prId: "pr-resume",
    repoId: "repo-resume",
    commitHash: opts.commitHash ?? "commit-current",
    diffHash: opts.diffHash ?? "diff-current",
    reviewConfigHash: opts.reviewConfigHash ?? "config-current",
    status: "in_progress",
    startedAt,
    completedAt: null,
    model: "test-model",
    rating: null,
    triggerReason: "manual",
    forced: false,
  });
  return runId;
}

async function writeRunCheckpoint(
  runId: string,
  overrides: Partial<{ commitHash: string; diffHash: string; reviewConfigHash: string; loopCount: number; checkpointId: string }> = {},
) {
  const { writeCheckpoint } = await import("../src/services/checkpointStore");
  writeCheckpoint(tmpRepo, runId, overrides.checkpointId ?? "__run", {
    version: 1,
    runId,
    checkpointId: overrides.checkpointId ?? "__run",
    commitHash: overrides.commitHash ?? "commit-current",
    diffHash: overrides.diffHash ?? "diff-current",
    reviewConfigHash: overrides.reviewConfigHash ?? "config-current",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "iter 1" },
    ],
    loopCount: overrides.loopCount ?? 1,
    maxIterations: 4,
    provider: "https://test.example.com/v1",
    model: "test-model",
    writtenAt: Date.now(),
  });
}

// Pull a handle on the in-memory store so each test can reset.
async function resetRuns() {
  const { prisma } = await import("../src/lib/prisma") as any;
  (prisma as any).__resetRuns();
}

describe("Phase 7 — assertNoActiveScan stale_inspectable contract", () => {
  it("returns stale_inspectable when a stale run has a __run checkpoint", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    await writeRunCheckpoint(runId);

    const { assertNoActiveScan } = await import("../src/lib/reviewFreshness");
    const result = await assertNoActiveScan("pr-resume", false, tmpRepo);
    expect(result.ok).toBe(false);
    if (!result.ok && "kind" in result && result.kind === "stale_inspectable") {
      expect(result.runId).toBe(runId);
      expect(result.checkpointId).toBe("__run");
      expect(result.completedIterations).toBe(1);
      expect(result.totalIterations).toBe(4);
      expect(result.lastProvider).toBe("https://test.example.com/v1");
    } else {
      throw new Error("expected stale_inspectable, got " + JSON.stringify(result));
    }
  });

  it("reaps (returns ok) when stale run has no checkpoint", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    // No writeRunCheckpoint call.

    const { assertNoActiveScan } = await import("../src/lib/reviewFreshness");
    const result = await assertNoActiveScan("pr-resume", false, tmpRepo);
    expect(result.ok).toBe(true);
  });

  it("returns busy when in_progress run is fresh (not stale)", async () => {
    await resetRuns();
    // Stale threshold is 5 minutes — seed a 30-second-old run.
    await seedStaleRun({ startedAgoMs: 30 * 1000 });
    await writeRunCheckpoint("run-stale");

    const { assertNoActiveScan, SCAN_STALE_AFTER_MS } = await import("../src/lib/reviewFreshness");
    expect(SCAN_STALE_AFTER_MS).toBeGreaterThan(30_000);
    const result = await assertNoActiveScan("pr-resume", false, tmpRepo);
    expect(result.ok).toBe(false);
    if (result.ok === false && !("kind" in result)) {
      expect(result.runId).toBe("run-stale");
    }
  });

  it("returns ok immediately when force=true (no inspection)", async () => {
    await resetRuns();
    await seedStaleRun();
    await writeRunCheckpoint("run-stale");

    const { assertNoActiveScan } = await import("../src/lib/reviewFreshness");
    const result = await assertNoActiveScan("pr-resume", true, tmpRepo);
    expect(result.ok).toBe(true);
  });

  it("prefers __run checkpoint over chunk checkpoints", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    // Write a chunk checkpoint first, then the run-level one.
    await writeRunCheckpoint(runId, { checkpointId: "chunk-1", loopCount: 2 });
    await writeRunCheckpoint(runId, { checkpointId: "__run", loopCount: 3 });

    const { assertNoActiveScan } = await import("../src/lib/reviewFreshness");
    const result = await assertNoActiveScan("pr-resume", false, tmpRepo);
    if (!result.ok && "kind" in result && result.kind === "stale_inspectable") {
      expect(result.checkpointId).toBe("__run");
      expect(result.completedIterations).toBe(3);
    } else {
      throw new Error("expected stale_inspectable preferring __run");
    }
  });
});

describe("Phase 7 — scan route resume contract", () => {
  it("returns status=interrupted on POST when stale checkpoint exists", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    await writeRunCheckpoint(runId);

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    const body = await res.json();
    expect(body.status).toBe("interrupted");
    expect(body.runId).toBe(runId);
    expect(body.checkpointId).toBe("__run");
    expect(body.completedIterations).toBe(1);
    expect(body.totalIterations).toBe(4);
    expect(body.resumeAllowed).toBe(true);
    expect(body.codeChanged).toBe(false);
    expect(body.configChanged).toBe(false);
  });

  it("flags resumeAllowed=false when commitHash differs", async () => {
    await resetRuns();
    const runId = await seedStaleRun({ commitHash: "commit-old" });
    await writeRunCheckpoint(runId, { commitHash: "commit-old" });

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    const body = await res.json();
    expect(body.status).toBe("interrupted");
    expect(body.resumeAllowed).toBe(false);
    expect(body.codeChanged).toBe(true);
  });

  it("flags resumeAllowed=false when reviewConfigHash differs", async () => {
    await resetRuns();
    const runId = await seedStaleRun({ reviewConfigHash: "config-old" });
    await writeRunCheckpoint(runId, { reviewConfigHash: "config-old" });

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    const body = await res.json();
    expect(body.status).toBe("interrupted");
    expect(body.resumeAllowed).toBe(false);
    expect(body.configChanged).toBe(true);
  });

  it("?resume=true returns 409 with RESUME_REJECTED_CODE_CHANGED when commit differs", async () => {
    await resetRuns();
    const runId = await seedStaleRun({ commitHash: "commit-old" });
    await writeRunCheckpoint(runId, { commitHash: "commit-old" });

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan?resume=true", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("RESUME_REJECTED_CODE_CHANGED");
  });

  it("?fresh=true deletes checkpoints and starts a new scan", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    await writeRunCheckpoint(runId);

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan?fresh=true", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    expect(res.status).toBe(200);
    // Checkpoint file should be gone after Start fresh.
    const cpPath = path.join(tmpRepo, ".dragnet", "checkpoints", runId, "__run.json");
    expect(fs.existsSync(cpPath)).toBe(false);
  });

  // Phase 9.9 — verifies the second arm of the resume-reject contract.
  // The CODE_CHANGED variant is covered above; this one ensures the
  // CONFIG_CHANGED arm produces the correct 409 + error code so the UI
  // can show "config drifted" rather than the generic "code drifted"
  // message when the user changes model/limits/prompt after interrupt.
  it("?resume=true returns 409 with RESUME_REJECTED_CONFIG_CHANGED when config differs", async () => {
    await resetRuns();
    const runId = await seedStaleRun({ reviewConfigHash: "config-old" });
    await writeRunCheckpoint(runId, { reviewConfigHash: "config-old" });

    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan?resume=true", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("RESUME_REJECTED_CONFIG_CHANGED");
  });

  // Phase 9.8 — verifies resume actually loads the checkpoint's loopCount
  // and passes it forward as startLoopCount (so iteration N+1, not 1).
  // The route logs `resuming run <id> from iteration <loopCount + 1>` at
  // the boundary; spy on console.log to capture it. Mocked chat.completions
  // returns submitReview on iteration 1 so the resumed run terminates.
  it("?resume=true loads checkpoint loopCount and logs resumption from iteration N+1", async () => {
    await resetRuns();
    const runId = await seedStaleRun();
    // Seed checkpoint at loopCount=3 — resume should log "iteration 4".
    await writeRunCheckpoint(runId, { loopCount: 3 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("../src/app/api/prs/[prId]/scan/route");
    const req = new Request("http://localhost/api/prs/pr-resume/scan?resume=true", {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ prId: "pr-resume" }) });
    expect(res.status).toBe(200);

    const calls = logSpy.mock.calls.map((args) => String(args[0]));
    expect(calls).toContainEqual(
      expect.stringContaining(`resuming run ${runId} from iteration 4`),
    );
    logSpy.mockRestore();
  });
});
