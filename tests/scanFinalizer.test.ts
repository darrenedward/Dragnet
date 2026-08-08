import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runFindUnique: vi.fn(),
  runUpdate: vi.fn(),
  runUpdateMany: vi.fn(),
  attempts: vi.fn(),
  chunks: vi.fn(),
  artifacts: vi.fn(),
  completeReviewRun: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findUnique: mocks.runFindUnique,
      update: mocks.runUpdate,
      updateMany: mocks.runUpdateMany,
    },
    reviewProviderAttempt: { findMany: mocks.attempts },
    reviewChunk: { findMany: mocks.chunks },
    reviewArtifact: { findMany: mocks.artifacts },
    reviewFinding: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../src/lib/reviewFreshness", () => ({ completeReviewRun: mocks.completeReviewRun }));

import { evaluateFinalizationEvidence, finalizeValidReviewRun } from "../src/services/scanFinalizer";

const complete = {
  providerAttempts: [{ status: "completed" }],
  chunks: [],
  artifacts: [
    { artifactKey: "checks", kind: "deterministic_checks" },
    { artifactKey: "review", kind: "review_result" },
  ],
};

describe("scan finalization evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runFindUnique.mockResolvedValue({ status: "in_progress", finalizationStatus: "pending" });
    mocks.runUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attempts.mockResolvedValue([{ status: "completed" }]);
    mocks.chunks.mockResolvedValue([]);
    mocks.artifacts.mockResolvedValue([
      { artifactKey: "checks", kind: "deterministic_checks" },
      { artifactKey: "review", kind: "review_result" },
    ]);
  });

  it("rejects incomplete provider, chunk, and artifact evidence", () => {
    const result = evaluateFinalizationEvidence({
      providerAttempts: [{ status: "running" }],
      chunks: [{ status: "failed" }],
      artifacts: [],
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([
      "provider_attempts_terminal",
      "chunks",
      "deterministic_checks",
      "review_result",
    ]));
  });

  it("does not treat a failed-only provider chain as successful evidence", () => {
    const result = evaluateFinalizationEvidence({
      providerAttempts: [{ status: "failed" }],
      chunks: [],
      artifacts: complete.artifacts,
    });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("provider_attempt_success");
  });

  it("accepts complete evidence deterministically", () => {
    expect(evaluateFinalizationEvidence(complete)).toEqual({ complete: true, missing: [] });
    expect(evaluateFinalizationEvidence(complete)).toEqual({ complete: true, missing: [] });
  });

  it("claims and finalizes once, then leaves a completed run authoritative", async () => {
    const publish = vi.fn().mockResolvedValue({ findings: [] });
    mocks.artifacts
      .mockResolvedValueOnce([
        { artifactKey: "checks", kind: "deterministic_checks" },
        { artifactKey: "review", kind: "review_result" },
      ])
      .mockResolvedValueOnce([
        { artifactKey: "checks", kind: "deterministic_checks" },
        { artifactKey: "review", kind: "review_result" },
        { artifactKey: "reconcile", kind: "reconciliation" },
      ]);
    const result = await finalizeValidReviewRun("run-1", { rating: 9 }, publish);
    expect(result.finalized).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(mocks.runUpdateMany).toHaveBeenCalledTimes(2);

    mocks.runFindUnique.mockResolvedValue({ status: "completed", finalizationStatus: "finalized" });
    const replay = await finalizeValidReviewRun("run-1", { rating: 1 }, publish);
    expect(replay.existing).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
