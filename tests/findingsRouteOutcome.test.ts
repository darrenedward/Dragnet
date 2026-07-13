import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-layer tests for issue #19: scan + findings responses carry the
 * new outcome/priorReviewRun fields so the frontend can derive button
 * label and popup content from per-PR persisted state.
 *
 * Mock posture mirrors tests/reposRoute.test.ts (session-or-key auth
 * bypass via apiAuth mock, prisma mock, helper-module mocks). Route
 * handlers are invoked directly with a fake Request + params promise.
 */

const mocks = vi.hoisted(() => ({
  mockAuthenticateSessionOrKey: vi.fn(),
  mockEnforcePrRepoScope: vi.fn(),
  mockGetLatestCompletedReview: vi.fn(),
  mockGetActiveScan: vi.fn(),
  mockGetRecentRuns: vi.fn(),
  mockPullRequestFindUnique: vi.fn(),
  mockPrFileFindMany: vi.fn(),
  mockReviewChunkFindMany: vi.fn(),
  mockReviewRunFindFirst: vi.fn(),
  mockReadPrCommitCount: vi.fn(),
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.mockAuthenticateSessionOrKey,
  enforcePrRepoScope: mocks.mockEnforcePrRepoScope,
}));

vi.mock("@/src/lib/reviewFreshness", () => ({
  getLatestCompletedReview: mocks.mockGetLatestCompletedReview,
  getActiveScan: mocks.mockGetActiveScan,
  getRecentRuns: mocks.mockGetRecentRuns,
  // scan route imports these — stub them so the module mock is complete.
  computeDiffHash: vi.fn().mockResolvedValue("diff-hash"),
  computeReviewConfigHash: vi.fn().mockResolvedValue("config-hash"),
  shortHash: vi.fn((s: string) => s.slice(0, 8)),
  assertReviewFreshness: vi.fn().mockResolvedValue(null),
  createReviewRun: vi.fn().mockResolvedValue("run-new"),
  completeReviewRun: vi.fn().mockResolvedValue(undefined),
  setReviewRunTokens: vi.fn().mockResolvedValue(undefined),
  setReviewRunLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  setReviewChunkLastCheckpointAt: vi.fn().mockResolvedValue(undefined),
  assertNoActiveScan: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/src/lib/stabilityScore", () => ({
  computeStability: vi.fn(() => ({ readyToMerge: true, score: 1 })),
  computeWeightedStability: vi.fn(() => ({ weightedStability: 1, readyToMerge: true })),
}));

vi.mock("@/src/lib/modelTrustWeights", () => ({
  lookupTrustWeight: vi.fn(() => 1),
}));

vi.mock("@/src/lib/prSizeProfile", () => ({
  computePrSizeProfile: vi.fn(() => ({ tier: "normal" })),
}));

vi.mock("@/src/lib/prSizeProfile.server", () => ({
  readPrCommitCount: mocks.mockReadPrCommitCount,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: mocks.mockPullRequestFindUnique,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFile: { findMany: mocks.mockPrFileFindMany },
    reviewChunk: { findMany: mocks.mockReviewChunkFindMany },
    reviewRun: {
      findFirst: mocks.mockReviewRunFindFirst,
      update: vi.fn().mockResolvedValue({}),
    },
    reviewFinding: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    repository: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    reviewLog: { create: vi.fn().mockResolvedValue({}) },
    reviewHistory: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { GET } from "../src/app/api/prs/[prId]/findings/route";

function makeFindingsRequest(prId: string): Request {
  return new Request(`http://localhost/api/prs/${prId}/findings`, {
    method: "GET",
  });
}

describe("GET /api/prs/[prId]/findings — outcome field (#19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({
      ok: true,
      user: { id: "u1" },
    });
    mocks.mockEnforcePrRepoScope.mockResolvedValue(null);
    mocks.mockGetActiveScan.mockResolvedValue({
      reviewRun: null,
      findings: [],
      iterationsByChunk: {},
    });
    mocks.mockGetRecentRuns.mockResolvedValue([]);
    mocks.mockPullRequestFindUnique.mockResolvedValue({
      sourceBranch: "feature/x",
      targetBranch: "main",
      repository: { id: "repo-1", path: null, baseBranch: "main" },
    });
    mocks.mockPrFileFindMany.mockResolvedValue([]);
    mocks.mockReviewChunkFindMany.mockResolvedValue([]);
    mocks.mockReadPrCommitCount.mockResolvedValue(1);
  });

  it("response includes reviewRun.outcome when the latest run was skipped", async () => {
    mocks.mockGetLatestCompletedReview.mockResolvedValue({
      reviewRun: {
        id: "run-skip",
        commitHash: "abc",
        diffHash: "def",
        reviewConfigHash: "cfg",
        completedAt: new Date("2026-07-01T00:00:00Z"),
        rating: null,
        model: null,
        triggerReason: "manual",
        reliability: null,
        refused: false,
        refusalNote: null,
        outcome: "skipped",
        status: "completed",
        chunksTotal: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksSkipped: 0,
        tokensUsed: null,
      },
      findings: [],
      regressions: [],
      rejectedFindings: [],
      rejectedCount: 0,
      stale: false,
    });

    const res = await GET(makeFindingsRequest("pr-skip"), {
      params: Promise.resolve({ prId: "pr-skip" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewRun).toMatchObject({
      id: "run-skip",
      outcome: "skipped",
      status: "completed",
      rating: null,
    });
  });

  it("response includes reviewRun.outcome='reviewed' for a normal successful scan", async () => {
    mocks.mockGetLatestCompletedReview.mockResolvedValue({
      reviewRun: {
        id: "run-success",
        commitHash: "abc",
        diffHash: "def",
        reviewConfigHash: "cfg",
        completedAt: new Date("2026-07-01T00:00:00Z"),
        rating: 9,
        model: "test-model",
        triggerReason: "manual",
        reliability: "complete",
        refused: false,
        refusalNote: null,
        outcome: "reviewed",
        status: "completed",
        chunksTotal: 1,
        chunksCompleted: 1,
        chunksFailed: 0,
        chunksSkipped: 0,
        tokensUsed: null,
      },
      findings: [],
      regressions: [],
      rejectedFindings: [],
      rejectedCount: 0,
      stale: false,
    });

    const res = await GET(makeFindingsRequest("pr-success"), {
      params: Promise.resolve({ prId: "pr-success" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewRun).toMatchObject({
      id: "run-success",
      outcome: "reviewed",
      status: "completed",
      rating: 9,
    });
  });

  it("response surfaces status='failed' when latest run failed (for button rose-state)", async () => {
    mocks.mockGetLatestCompletedReview.mockResolvedValue({
      reviewRun: {
        id: "run-failed",
        commitHash: "abc",
        diffHash: "def",
        reviewConfigHash: "cfg",
        completedAt: new Date("2026-07-01T00:00:00Z"),
        rating: null,
        model: null,
        triggerReason: "manual",
        reliability: null,
        refused: false,
        refusalNote: null,
        outcome: null,
        status: "failed",
        chunksTotal: 0,
        chunksCompleted: 0,
        chunksFailed: 0,
        chunksSkipped: 0,
        tokensUsed: null,
      },
      findings: [],
      regressions: [],
      rejectedFindings: [],
      rejectedCount: 0,
      stale: false,
    });

    const res = await GET(makeFindingsRequest("pr-failed"), {
      params: Promise.resolve({ prId: "pr-failed" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewRun).toMatchObject({
      status: "failed",
      outcome: null,
    });
  });
});
