import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  reviewRunFindFirst: vi.fn(),
  reviewRunCreate: vi.fn(),
  reviewFindingFindMany: vi.fn(),
  pullRequestFindUnique: vi.fn(),
  prFileFindMany: vi.fn(),
}));

vi.mock("../../../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findFirst: prismaMocks.reviewRunFindFirst,
      create: prismaMocks.reviewRunCreate,
    },
    reviewFinding: {
      findMany: prismaMocks.reviewFindingFindMany,
    },
    pullRequest: {
      findUnique: prismaMocks.pullRequestFindUnique,
    },
    prFile: {
      findMany: prismaMocks.prFileFindMany,
    },
  },
}));

import {
  assertReviewFreshness,
  createReviewRun,
  getLatestCompletedReview,
  parseIterationLogs,
} from "../../../src/lib/reviewFreshness";

beforeEach(() => {
  prismaMocks.reviewRunFindFirst.mockReset();
  prismaMocks.reviewRunCreate.mockReset();
  prismaMocks.reviewFindingFindMany.mockReset();
  prismaMocks.pullRequestFindUnique.mockReset();
  prismaMocks.prFileFindMany.mockReset();

  // Default mock posture for the getLatestCompletedReview suite:
  // a completed run exists, the PR is queried, and there are no PR files
  // (empty diff → currentDiffHash === "" → stale=false). The findings
  // and rejectedFindings mocks return [] by default; specific tests
  // override per-case.
  prismaMocks.reviewRunFindFirst.mockResolvedValue({
    id: "run-latest",
    commitHash: "commit-current",
    diffHash: "diff-current",
    reviewConfigHash: "config-current",
    completedAt: new Date("2026-07-14T00:00:00Z"),
    rating: 8,
    model: "test-model",
    triggerReason: "manual",
    reliability: null,
    refused: false,
    refusalNote: null,
    outcome: "reviewed",
    status: "completed",
    chunksTotal: 0,
    chunksCompleted: 0,
    chunksFailed: 0,
    chunksSkipped: 0,
    tokensUsed: null,
  });
  prismaMocks.pullRequestFindUnique.mockResolvedValue({ commitHash: "commit-current" });
  prismaMocks.prFileFindMany.mockResolvedValue([]);
  // reviewFinding.findMany is called THREE times per getLatestCompletedReview
  // invocation (findings, rejectedFindings, regressions). Use mockImplementation
  // so each call gets a fresh [] unless a specific test overrides.
  prismaMocks.reviewFindingFindMany.mockResolvedValue([]);
});

describe("reviewFreshness > freshness gate", () => {
  describe("assertReviewFreshness", () => {
    const pr = { id: "pr-1", commitHash: "commit-current" };
    const matchingRun = {
      id: "run-1",
      commitHash: "commit-current",
      diffHash: "diff-current",
      reviewConfigHash: "config-current",
      rating: 8,
      reliability: null,
    };

    it("reuses a matching completed run with a concrete rating", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue(matchingRun);

      await expect(
        assertReviewFreshness(pr, "diff-current", "config-current"),
      ).resolves.toEqual({ ok: true, runId: "run-1", rating: 8 });
    });

    it("does not reuse a matching completed run with null rating", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue({ ...matchingRun, rating: null });

      const result = await assertReviewFreshness(pr, "diff-current", "config-current");

      expect(result.ok).toBe(false);
      if (!("kind" in result)) throw new Error("expected cache miss for null rating");
      expect(result.kind).toBe("STALE_RUN");
      expect(result.message).toContain("rating=null");
    });

    it("does not reuse a matching completed run with partial reliability", async () => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue({ ...matchingRun, reliability: "partial" });

      const result = await assertReviewFreshness(pr, "diff-current", "config-current");

      expect(result.ok).toBe(false);
      if (!("kind" in result)) throw new Error("expected cache miss for partial reliability");
      expect(result.kind).toBe("STALE_RUN");
      expect(result.message).toContain("reliability=partial");
    });

    it("reuses a completed run when the commit hash moved but the diff + config match (issue #33 — no-op rebase)", async () => {
      // No-op rebase scenario: a new commit hash on the PR (e.g. force-push
      // or rebase) but the diff text is byte-identical. With content-only
      // diffHash (#33) the freshness tuple matches and the cached review is
      // reused — rating stays stable instead of moving on a non-code change.
      const priorRunOnEarlierCommit = {
        ...matchingRun,
        commitHash: "commit-earlier", // PR commit has moved on
      };
      prismaMocks.reviewRunFindFirst.mockResolvedValue(priorRunOnEarlierCommit);

      const result = await assertReviewFreshness(
        { id: "pr-1", commitHash: "commit-current" }, // PR's current commit
        "diff-current", // but the diff content hasn't moved
        "config-current",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected cache HIT on no-op rebase");
      expect(result.runId).toBe("run-1");
      expect(result.rating).toBe(8);
    });

    it("does not reuse a run when only the reviewConfigHash differs", async () => {
      // Different config (e.g. swapped chat model or prompt) must invalidate
      // the cache even when the diff content is identical — the cached
      // review was produced by a different config and would be stale.
      prismaMocks.reviewRunFindFirst.mockResolvedValue(matchingRun);

      const result = await assertReviewFreshness(pr, "diff-current", "config-different");

      expect(result.ok).toBe(false);
      if (!("kind" in result)) throw new Error("expected cache miss for config drift");
      expect(result.kind).toBe("STALE_RUN");
      expect(result.message).toContain("configHash config-d");
    });
  });

  describe("parseIterationLogs", () => {
    it("resets displayed progress when a fallback provider starts its own budget", () => {
      const parsed = parseIterationLogs([
        { message: "Iteration 1/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 2/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 3/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 4/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Loop exhausted — no submitReview after 4 iterations", reviewChunkId: "chunk-a" },
        { message: "Iteration 1/16 — Minimax", reviewChunkId: "chunk-a" },
        { message: "Iteration 2/16 — Minimax", reviewChunkId: "chunk-a" },
      ]);

      expect(parsed["chunk-a"]).toEqual({ current: 2, max: 16, provider: "Minimax" });
    });

    it("tracks each chunk independently", () => {
      const parsed = parseIterationLogs([
        { message: "Iteration 4/4 — NVIDIA", reviewChunkId: "chunk-a" },
        { message: "Iteration 1/16 — Minimax", reviewChunkId: "chunk-a" },
        { message: "Iteration 3/4 — NVIDIA", reviewChunkId: "chunk-b" },
      ]);

      expect(parsed["chunk-a"]).toEqual({ current: 1, max: 16, provider: "Minimax" });
      expect(parsed["chunk-b"]).toEqual({ current: 3, max: 4, provider: "NVIDIA" });
    });
  });

  describe("createReviewRun", () => {
    it("persists createdByUserId when provided", async () => {
      prismaMocks.reviewRunCreate.mockResolvedValue({ id: "run-new" });
      const id = await createReviewRun({
        prId: "pr-1",
        repoId: "repo-1",
        commitHash: "abc",
        diffHash: "def",
        reviewConfigHash: "ghi",
        createdByUserId: "user-42",
      });
      expect(id).toMatch(/^run-/);
      expect(prismaMocks.reviewRunCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdByUserId: "user-42" }),
        }),
      );
    });

    it("persists createdByUserId as null when omitted (legacy/webhook runs)", async () => {
      prismaMocks.reviewRunCreate.mockResolvedValue({ id: "run-new" });
      await createReviewRun({
        prId: "pr-1",
        repoId: "repo-1",
        commitHash: "abc",
        diffHash: "def",
        reviewConfigHash: "ghi",
      });
      expect(prismaMocks.reviewRunCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ createdByUserId: null }),
        }),
      );
    });
  });

  // ===== Issue #31: getLatestCompletedReview returns surviving priors =====
  //
  // After a re-scan, reconcileFindingsAcrossRuns() bumps prior.lastSeenRunId
  // to the latest run and deletes the matched-new duplicate. The surviving
  // prior row has reviewRunId pointing at the FIRST run it was detected in,
  // not the latest. The findings query therefore must match on EITHER
  // reviewRunId = latestRun.id OR lastSeenRunId = latestRun.id, otherwise
  // the surviving row disappears from the PR page (the log says "1 finding"
  // but the page renders 0).

  describe("getLatestCompletedReview — lastSeenRunId match (issue #31)", () => {
    const latestRun = {
      id: "run-latest",
      commitHash: "commit-current",
      diffHash: "diff-current",
      reviewConfigHash: "config-current",
      completedAt: new Date("2026-07-14T00:00:00Z"),
      rating: 8,
      model: "test-model",
      triggerReason: "manual",
      reliability: null,
      refused: false,
      refusalNote: null,
      outcome: "reviewed",
      status: "completed",
      chunksTotal: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
      chunksSkipped: 0,
      tokensUsed: null,
    };

    beforeEach(() => {
      prismaMocks.reviewRunFindFirst.mockResolvedValue(latestRun);
      prismaMocks.pullRequestFindUnique.mockResolvedValue({ commitHash: "commit-current" });
      prismaMocks.prFileFindMany.mockResolvedValue([]);
    });

    it("findings query OR-matches on lastSeenRunId = latestRun.id (so surviving priors render)", async () => {
      await getLatestCompletedReview("pr-1");

      // The first reviewFinding.findMany call is the active findings query.
      // The second is the rejectedFindings query. The third is the regressions
      // query. We assert the first two.
      expect(prismaMocks.reviewFindingFindMany).toHaveBeenCalledTimes(3);
      const findingsWhere = prismaMocks.reviewFindingFindMany.mock.calls[0][0].where;
      expect(findingsWhere.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lastSeenRunId: latestRun.id }),
        ]),
      );
      expect(findingsWhere.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reviewRunId: latestRun.id }),
        ]),
      );
    });

    it("rejectedFindings query OR-matches on lastSeenRunId = latestRun.id (so flipped-to-rejected priors render)", async () => {
      await getLatestCompletedReview("pr-1");

      const rejectedWhere = prismaMocks.reviewFindingFindMany.mock.calls[1][0].where;
      expect(rejectedWhere.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lastSeenRunId: latestRun.id }),
        ]),
      );
      expect(rejectedWhere.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reviewRunId: latestRun.id }),
        ]),
      );
    });

    it("surviving prior row (lastSeenRunId=latestRun.id, reviewRunId=earlier) is returned in findings", async () => {
      // After reconcileAcrossRuns: prior row's reviewRunId still points at
      // "run-earlier" (the run that first detected it), but lastSeenRunId
      // is bumped to "run-latest". The findings query must include it.
      const survivingPrior = {
        id: "prior-1",
        prId: "pr-1",
        reviewRunId: "run-earlier",
        repoId: "repo-1",
        category: "Correctness",
        severity: "blocker",
        exploitability: null,
        impact: null,
        filename: "src/foo.ts",
        line: 42,
        explanation: "Stale handler",
        diffSuggestion: null,
        evidenceChain: null,
        confidence: 0.9,
        confidenceReason: null,
        verificationStatus: "verified",
        verificationNote: null,
        skepticVerdict: "confirmed",
        skepticNote: "Confirmed by skeptic",
        source: null,
        timestamp: "2026-07-13T00:00:00Z",
        isRegression: false,
        regressedFromRunId: null,
      };

      // First call (findings) returns the surviving prior.
      // Second call (rejectedFindings) returns [].
      // Third call (regressions) returns [].
      prismaMocks.reviewFindingFindMany
        .mockResolvedValueOnce([survivingPrior])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await getLatestCompletedReview("pr-1");

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        id: "prior-1",
        skepticVerdict: "confirmed",
        skepticNote: "Confirmed by skeptic",
        verificationStatus: "verified",
      });
    });

    it("surviving prior row that flipped to skepticVerdict='rejected' is returned in rejectedFindings", async () => {
      // Edge case from the issue: after re-scan, skeptic rejected a finding
      // the prior scan confirmed. The prior row's skepticVerdict is now
      // 'rejected'. It must show up in the rejected list (not the active
      // findings list).
      const flippedPrior = {
        id: "prior-1",
        filename: "src/foo.ts",
        line: 42,
        severity: "warning",
        category: "Correctness",
        explanation: "Code path no longer reachable",
        verificationStatus: "verified",
        verificationNote: null,
        skepticVerdict: "rejected",
        skepticNote: "Code path no longer reaches this branch",
        source: null,
      };

      prismaMocks.reviewFindingFindMany
        .mockResolvedValueOnce([]) // findings
        .mockResolvedValueOnce([flippedPrior]) // rejectedFindings
        .mockResolvedValueOnce([]); // regressions

      const result = await getLatestCompletedReview("pr-1");

      expect(result.rejectedFindings).toHaveLength(1);
      expect(result.rejectedCount).toBe(1);
      expect(result.rejectedFindings[0]).toMatchObject({
        id: "prior-1",
        skepticVerdict: "rejected",
        skepticNote: "Code path no longer reaches this branch",
      });
    });
  });
});