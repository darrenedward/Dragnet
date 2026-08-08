import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ owner: "none", takeover: false }));
const { prisma } = vi.hoisted(() => ({ prisma: {
  reviewRun: { findUnique: vi.fn(), update: vi.fn() },
  repository: { findUnique: vi.fn() },
  reviewChunk: { findMany: vi.fn(), update: vi.fn() },
  prFile: { findMany: vi.fn() },
  pullRequest: { updateMany: vi.fn() },
  reviewLog: { create: vi.fn() },
} }));

vi.mock("../../src/lib/prisma", () => ({ prisma }));
vi.mock("../../src/services/reviewService", () => ({
  SYSTEM_INSTRUCTION: "test system prompt",
  runPrScan: vi.fn(),
}));
vi.mock("../../src/lib/llmClient", () => ({ getChatChain: vi.fn().mockReturnValue([]) }));
vi.mock("../../src/services/largePrReview/aggregator", () => ({
  aggregateResults: vi.fn().mockResolvedValue({
    rating: 9,
    findings: [],
    reliability: "complete",
    chunksTotal: 1,
    chunksCompleted: 1,
    chunksFailed: 0,
    chunksSkipped: 0,
    chunksIncomplete: 0,
  }),
}));
vi.mock("../../src/lib/githubApp", () => ({ getInstallationToken: vi.fn() }));

import { retryFailedChunks } from "../../src/services/largePrReview/orchestrator";
import { computeDiffHash, computeReviewConfigHash, shortHash } from "../../src/lib/reviewFreshness";
import { SYSTEM_INSTRUCTION } from "../../src/services/reviewService";
import { getChatChain } from "../../src/lib/llmClient";
import { runPrScan } from "../../src/services/reviewService";
import { aggregateResults } from "../../src/services/largePrReview/aggregator";
import { readLimits } from "../../src/lib/prSizeConfig";

const files = [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, originalContent: "", modifiedContent: "x", diff: "+x" }];

describe("large PR resume ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.owner = "none";
    state.takeover = false;
    const diffHash = computeDiffHash(files);
    const configHash = computeReviewConfigHash(getChatChain(), shortHash(SYSTEM_INSTRUCTION), readLimits());
    prisma.reviewRun.findUnique.mockImplementation(({ select }: { select?: { ownerToken?: boolean } }) => {
      if (select?.ownerToken) {
        return Promise.resolve({ status: "in_progress", ownerToken: state.takeover ? "new-owner" : state.owner });
      }
      return Promise.resolve({
        id: "run-1", prId: "pr-1", repoId: "repo-1", commitHash: "sha-1", diffHash: diffHash,
        reviewConfigHash: configHash, pullRequest: { commitHash: "sha-1" },
      });
    });
    prisma.reviewRun.update.mockImplementation(({ data }: { data: { ownerToken?: string } }) => {
      if (data.ownerToken) state.owner = data.ownerToken;
      return Promise.resolve({});
    });
    prisma.repository.findUnique.mockResolvedValue({ path: "/repo", installationId: null });
    prisma.prFile.findMany.mockResolvedValue(files);
    prisma.reviewChunk.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) => {
      if (where.status) return Promise.resolve([{ id: "chunk-1", label: "chunk-1", filePaths: ["src/a.ts"], lineCount: 1, touchesSecuritySensitive: false }]);
      return Promise.resolve([{ status: "completed" }]);
    });
    prisma.reviewChunk.update.mockResolvedValue({});
    prisma.pullRequest.updateMany.mockResolvedValue({});
    prisma.reviewLog.create.mockResolvedValue({});
    vi.mocked(runPrScan).mockResolvedValue({ ok: true, rating: 9, findings: [], usedModel: "test", summary: "ok" } as any);
  });

  it("rejects resume when commit/diff/config identity has drifted", async () => {
    prisma.reviewRun.findUnique.mockImplementationOnce(() => Promise.resolve({
      id: "run-1", prId: "pr-1", repoId: "repo-1", commitHash: "old-sha", diffHash: "old-diff",
      reviewConfigHash: "old-config", pullRequest: { commitHash: "new-sha" },
    }));

    await expect(retryFailedChunks("run-1")).rejects.toThrow(/identity changed/i);
    expect(prisma.reviewRun.update).not.toHaveBeenCalled();
    expect(runPrScan).not.toHaveBeenCalled();
  });

  it("stops without aggregating when another worker takes ownership mid-chunk", async () => {
    vi.mocked(runPrScan).mockImplementationOnce(async () => {
      state.takeover = true;
      return { ok: true, rating: 9, findings: [], usedModel: "test", summary: "ok" } as any;
    });

    await expect(retryFailedChunks("run-1")).rejects.toThrow(/ownership changed/i);
    expect(aggregateResults).not.toHaveBeenCalled();
    expect(prisma.reviewChunk.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    );
  });
});
