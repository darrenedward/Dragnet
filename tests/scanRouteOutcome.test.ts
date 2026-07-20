import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-layer test for issue #19: scan response carries `priorReviewRun`
 * (most recent NON-SKIPPED prior completed run for the same PR) so the
 * TrivialSkipNotice popup can honestly show "your last code grade was
 * X/10 from Y" without snapshotting reviewRun before the refetch.
 *
 * The scan route has many dependencies; this test mocks them all so we
 * can drive the success terminal of POST /api/prs/[prId]/scan with a
 * fixture PR and assert the response shape. The point is the response
 * contract, not the scan logic itself.
 */

const mocks = vi.hoisted(() => ({
  mockAuthenticateSessionOrKey: vi.fn(),
  mockEnforcePrRepoScope: vi.fn(),
  mockRunPrScan: vi.fn(),
  mockPullRequestFindUnique: vi.fn(),
  mockPullRequestUpdateMany: vi.fn(),
  mockReviewRunFindFirst: vi.fn(),
  mockReviewRunFindUnique: vi.fn(),
  mockReviewRunCreate: vi.fn(),
  mockPrFileFindMany: vi.fn(),
  mockReviewChunkFindMany: vi.fn(),
  mockRepositoryFindUnique: vi.fn(),
  mockRefreshPrFiles: vi.fn(),
  mockIsBranchMerged: vi.fn(),
  mockAssertIndexFresh: vi.fn(),
  mockIndexingServiceIsIndexing: vi.fn(),
  mockAcquireReviewLock: vi.fn(),
  mockEndReview: vi.fn(),
  mockCheckPendingAbort: vi.fn(),
  mockAssertTier: vi.fn(),
  mockBuildDiffManifest: vi.fn(),
  mockReadCheckpoint: vi.fn(),
  mockDeleteRunCheckpoints: vi.fn(),
  mockReadPrCommitCount: vi.fn(),
  mockAssertReviewFreshness: vi.fn(),
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.mockAuthenticateSessionOrKey,
  enforcePrRepoScope: mocks.mockEnforcePrRepoScope,
}));

vi.mock("@/src/services/reviewService", () => ({
  runPrScan: mocks.mockRunPrScan,
  SYSTEM_INSTRUCTION: "stub-system-instruction",
}));

vi.mock("@/src/lib/getRealPrs", () => ({
  refreshPrFiles: mocks.mockRefreshPrFiles,
  isBranchMerged: mocks.mockIsBranchMerged,
}));

vi.mock("@/src/lib/indexFreshness", () => ({
  assertIndexFresh: mocks.mockAssertIndexFresh,
}));

vi.mock("@/src/services/indexingService", () => ({
  IndexingService: {
    isIndexing: mocks.mockIndexingServiceIsIndexing,
  },
}));

vi.mock("@/src/lib/llmClient", () => ({
  getChatChain: () => [{ client: {}, model: "m", name: "n", endpoint: "e", maxIterations: 4 }],
  getEmbeddingChain: () => [{ client: {}, model: "m", name: "n", endpoint: "e" }],
}));

vi.mock("@/src/lib/reviewLocks", () => ({
  acquireReviewLock: mocks.mockAcquireReviewLock,
  endReview: mocks.mockEndReview,
  checkPendingAbort: mocks.mockCheckPendingAbort,
}));

vi.mock("@/src/lib/prSizeProfile", () => ({
  computePrSizeProfile: vi.fn(() => ({ tier: "normal" })),
}));

vi.mock("@/src/lib/prSizeProfile.server", () => ({
  readPrCommitCount: mocks.mockReadPrCommitCount,
}));

vi.mock("@/src/services/largePrReview", () => ({
  assertTier: mocks.mockAssertTier,
  buildDiffManifest: mocks.mockBuildDiffManifest,
  runLargePrReview: vi.fn(),
}));

vi.mock("@/src/lib/prSizeConfig", () => ({
  readLimits: vi.fn(() => ({})),
}));

vi.mock("@/src/lib/reviewFreshness", () => ({
  computeDiffHash: vi.fn().mockReturnValue("diff-hash"),
  computeReviewConfigHash: vi.fn().mockReturnValue("config-hash"),
  shortHash: vi.fn((s: string) => s.slice(0, 8)),
  assertReviewFreshness: mocks.mockAssertReviewFreshness,
  createReviewRun: mocks.mockReviewRunCreate,
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/src/services/checkpointStore", () => ({
  readCheckpoint: mocks.mockReadCheckpoint,
  deleteRunCheckpoints: vi.fn().mockResolvedValue(undefined),
  RUN_CHECKPOINT_ID: "__run",
}));

vi.mock("@/src/services/deterministicChecks/logging", () => ({
  logReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: mocks.mockPullRequestFindUnique,
      updateMany: mocks.mockPullRequestUpdateMany,
    },
    repository: {
      findUnique: mocks.mockRepositoryFindUnique,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: mocks.mockPrFileFindMany },
    reviewChunk: { findMany: mocks.mockReviewChunkFindMany },
    reviewRun: {
      findFirst: mocks.mockReviewRunFindFirst,
      findUnique: mocks.mockReviewRunFindUnique,
      create: mocks.mockReviewRunCreate,
      update: vi.fn().mockResolvedValue({}),
    },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { POST } from "../src/app/api/prs/[prId]/scan/route";

function makeScanRequest(prId: string, body: unknown): Request {
  return new Request(`http://localhost/api/prs/${prId}/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/prs/[prId]/scan — priorReviewRun field (#19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: true, user: { id: "u1" } });
    mocks.mockEnforcePrRepoScope.mockResolvedValue(null);
    mocks.mockRefreshPrFiles.mockResolvedValue([
      { filename: "src/foo.ts", status: "modified", additions: 1, deletions: 1 },
    ]);
    mocks.mockIsBranchMerged.mockResolvedValue(false);
    mocks.mockAssertIndexFresh.mockResolvedValue({ ok: true });
    mocks.mockIndexingServiceIsIndexing.mockResolvedValue(false);
    mocks.mockAcquireReviewLock.mockResolvedValue({ status: "acquired" });
    mocks.mockEndReview.mockReturnValue(undefined);
    mocks.mockCheckPendingAbort.mockReturnValue(false);
    mocks.mockAssertTier.mockReturnValue({ tier: "normal" });
    mocks.mockBuildDiffManifest.mockResolvedValue({ manifest: [], warning: null });
    mocks.mockReadCheckpoint.mockResolvedValue(null);
    mocks.mockReadPrCommitCount.mockResolvedValue(1);
    mocks.mockAssertReviewFreshness.mockResolvedValue({ ok: false, kind: "NO_RUN" });
    mocks.mockReviewRunCreate.mockResolvedValue("run-current");
    mocks.mockPullRequestFindUnique.mockResolvedValue({
      id: "pr-1",
      repoId: "repo-1",
      commitHash: "abc",
      sourceBranch: "feature/x",
      targetBranch: "main",
      repository: {
        id: "repo-1",
        path: "/tmp/repo",
        localPath: null,
        baseBranch: "main",
        cloneUrl: "https://example.com/repo.git",
      },
    });
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      path: "/tmp/repo",
      localPath: null,
      baseBranch: "main",
      cloneUrl: "https://example.com/repo.git",
      installCommand: "npm install",
      testCommand: "npm test",
    });
    mocks.mockPrFileFindMany.mockResolvedValue([]);
    mocks.mockReviewChunkFindMany.mockResolvedValue([]);
    mocks.mockReviewRunFindUnique.mockResolvedValue({ id: "run-current", status: "in_progress" });
    mocks.mockPullRequestUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("response includes priorReviewRun when a prior non-skipped completed run exists", async () => {
    // Current scan trivial-skips; the prior run (rating=8, from June) is
    // what the popup should display. Backend must surface it via the
    // priorReviewRun field on the response.
    mocks.mockRunPrScan.mockResolvedValue({
      success: true,
      rating: null,
      findings: [],
      usedModel: "none (skipped)",
      systemWarn: "Trivial skip",
    });
    const priorDate = new Date("2026-06-15T12:00:00Z");
    mocks.mockReviewRunFindFirst.mockResolvedValue({
      rating: 8,
      completedAt: priorDate,
    });

    const res = await POST(makeScanRequest("pr-1", { repoId: "repo-1" }), {
      params: Promise.resolve({ prId: "pr-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priorReviewRun).toEqual({
      rating: 8,
      completedAt: priorDate.toISOString(),
    });

    // Assert the lookup query excluded skipped runs and the just-finished run.
    expect(mocks.mockReviewRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          prId: "pr-1",
          status: "completed",
          outcome: { not: "skipped" },
          id: { not: "run-current" },
        }),
        orderBy: { completedAt: "desc" },
        select: { rating: true, completedAt: true },
      }),
    );
  });

  it("response sets priorReviewRun=null when no prior non-skipped run exists", async () => {
    // Fresh PR — no prior code review. Popup must honestly show "no prior
    // grade" rather than fabricate one. priorReviewRun should be null.
    mocks.mockRunPrScan.mockResolvedValue({
      success: true,
      rating: null,
      findings: [],
      usedModel: "none (skipped)",
      systemWarn: "Trivial skip",
    });
    mocks.mockReviewRunFindFirst.mockResolvedValue(null);

    const res = await POST(makeScanRequest("pr-1", { repoId: "repo-1" }), {
      params: Promise.resolve({ prId: "pr-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priorReviewRun).toBeNull();
  });

  it("lookup excludes skipped prior runs (only non-skipped completed runs qualify)", async () => {
    // Critical: a prior run with outcome="skipped" must NOT be returned
    // as the popup's "prior grade". The query filter `outcome: { not: "skipped" }`
    // is what enforces this — assert the mock was called with that filter.
    mocks.mockRunPrScan.mockResolvedValue({
      success: true,
      rating: null,
      findings: [],
      usedModel: "none (skipped)",
      systemWarn: "Trivial skip",
    });
    mocks.mockReviewRunFindFirst.mockResolvedValue(null);

    await POST(makeScanRequest("pr-1", { repoId: "repo-1" }), {
      params: Promise.resolve({ prId: "pr-1" }),
    });

    const call = mocks.mockReviewRunFindFirst.mock.calls[0]?.[0];
    expect(call?.where?.outcome).toEqual({ not: "skipped" });
    // Status filter ensures we don't surface in_progress / failed prior runs.
    expect(call?.where?.status).toBe("completed");
  });
});
