import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: {
  reviewRun: {
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
  reviewChunk: { findMany: vi.fn() },
  repository: {
    findUnique: vi.fn().mockResolvedValue({ path: "/repo", localPath: null }),
    updateMany: vi.fn().mockResolvedValue({}),
  },
  reviewFinding: { findMany: vi.fn().mockResolvedValue([]) },
  reviewHistory: {
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  },
} }));

vi.mock("../../src/lib/prisma", () => ({ prisma }));
vi.mock("../../src/services/largePrReview/publishFindings", () => ({
  publishFindingsForRun: vi.fn().mockResolvedValue({ findings: [] }),
}));
vi.mock("../../src/services/findingLifecycle/bugFixTracker", () => ({
  recordFixesForCompletedScan: vi.fn().mockResolvedValue({ written: 0, skipped: 0 }),
}));
vi.mock("../../src/lib/prRevisionStatus", () => ({
  completePrReviewIfCurrent: vi.fn().mockResolvedValue(undefined),
}));

import { aggregateResults } from "../../src/services/largePrReview/aggregator";

describe("aggregateResults coverage contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewRun.findUnique.mockResolvedValue({
      id: "run-1",
      prId: "pr-1",
      repoId: "repo-1",
      commitHash: "sha-1",
      model: "test-model",
      status: "in_progress",
      pullRequest: { sourceBranch: "feature" },
    });
  });

  it("keeps a 9/17 run incomplete and does not publish terminal side effects", async () => {
    prisma.reviewChunk.findMany.mockResolvedValue([
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `chunk-${index}`,
        label: `chunk-${index}`,
        status: "completed",
        rating: 9,
        lineCount: 100,
        touchesSecuritySensitive: false,
        skipReason: null,
      })),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `pending-${index}`,
        label: `pending-${index}`,
        status: "pending",
        rating: null,
        lineCount: 100,
        touchesSecuritySensitive: false,
        skipReason: null,
      })),
    ]);

    const result = await aggregateResults("run-1");

    expect(result).toMatchObject({
      reliability: "partial",
      rating: null,
      chunksTotal: 17,
      chunksCompleted: 9,
      chunksIncomplete: 8,
    });
    expect(prisma.reviewRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        systemWarn: "Review incomplete: 9/17 chunks reached a terminal state.",
      }),
    }));
    const { recordFixesForCompletedScan } = await import("../../src/services/findingLifecycle/bugFixTracker");
    expect(recordFixesForCompletedScan).not.toHaveBeenCalled();
  });

  it("completes only when every chunk is terminal", async () => {
    prisma.reviewChunk.findMany.mockResolvedValue([
      { id: "1", label: "one", status: "completed", rating: 9, lineCount: 100, touchesSecuritySensitive: false, skipReason: null },
      { id: "2", label: "two", status: "failed", rating: null, lineCount: 100, touchesSecuritySensitive: false, skipReason: null },
      { id: "3", label: "three", status: "skipped", rating: null, lineCount: 100, touchesSecuritySensitive: false, skipReason: "not code" },
    ]);

    const result = await aggregateResults("run-1");

    expect(result).toMatchObject({
      reliability: "partial",
      chunksIncomplete: 0,
      chunksFailed: 1,
      chunksSkipped: 1,
    });
    expect(prisma.reviewRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "completed" }),
    }));
  });
});
