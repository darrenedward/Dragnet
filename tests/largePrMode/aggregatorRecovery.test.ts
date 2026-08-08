import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  chunks: [
    { id: "run-1-a", status: "completed", rating: 8, lineCount: 100, touchesSecuritySensitive: false, label: "A", skipReason: null },
    { id: "run-1-b", status: "failed", rating: null, lineCount: 100, touchesSecuritySensitive: false, label: "B", skipReason: null },
  ],
  update: vi.fn(),
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: "run-1",
        prId: "pr-1",
        repoId: "repo-1",
        commitHash: "commit-1",
        model: "model-1",
        pullRequest: { sourceBranch: "feature" },
      }),
      update: state.update,
    },
    reviewChunk: { findMany: vi.fn().mockImplementation(async () => state.chunks) },
  },
}));
vi.mock("../../src/services/largePrReview/publishFindings", () => ({ publishFindingsForRun: vi.fn() }));
vi.mock("../../src/services/findingLifecycle/bugFixTracker", () => ({ recordFixesForCompletedScan: vi.fn() }));
vi.mock("../../src/lib/prRevisionStatus", () => ({ completePrReviewIfCurrent: vi.fn() }));

describe("large-PR aggregation recovery", () => {
  beforeEach(() => state.update.mockClear());

  it("keeps the run recoverable while any required chunk is incomplete", async () => {
    const { aggregateResults } = await import("../../src/services/largePrReview/aggregator");
    const result = await aggregateResults("run-1");

    expect(result.terminalized).toBe(false);
    expect(result.rating).toBeNull();
    expect(result.chunksCompleted).toBe(1);
    expect(result.chunksFailed).toBe(1);
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "in_progress", completedAt: null, rating: null }),
    }));
  });
});
