import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewProviderAttempt = {
  upsert: vi.fn(),
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
};
const reviewArtifact = {
  upsert: vi.fn(),
  findMany: vi.fn(),
};
const reviewCheckpoint = {
  upsert: vi.fn(),
  findMany: vi.fn(),
};

vi.mock("../src/lib/prisma", () => ({
  prisma: { reviewProviderAttempt, reviewArtifact, reviewCheckpoint },
}));

describe("durable scan state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewProviderAttempt.upsert.mockResolvedValue({});
    reviewProviderAttempt.create.mockResolvedValue({});
    reviewProviderAttempt.findUnique.mockResolvedValue(null);
    reviewProviderAttempt.update.mockResolvedValue({});
    reviewArtifact.upsert.mockResolvedValue({});
    reviewCheckpoint.upsert.mockResolvedValue({});
    reviewProviderAttempt.findMany.mockResolvedValue([{ attemptKey: "primary" }]);
    reviewArtifact.findMany.mockResolvedValue([{ artifactKey: "checks" }]);
    reviewCheckpoint.findMany.mockResolvedValue([{ checkpointId: "__run" }]);
  });

  it("upserts a stable provider attempt and records its terminal outcome", async () => {
    const { beginProviderAttempt, completeProviderAttempt } = await import("../src/services/durableScanState");

    await beginProviderAttempt({
      reviewRunId: "run-1",
      attemptKey: "primary:1",
      attemptOrdinal: 0,
      provider: "Agnes",
      model: "agnes-2.0-flash",
      maxIterations: 2,
    });
    await completeProviderAttempt({
      reviewRunId: "run-1",
      attemptKey: "primary:1",
      status: "failed",
      outcome: "transport_failure",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      iterationsUsed: 2,
      maxIterations: 2,
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.03,
    });

    expect(reviewProviderAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "running", provider: "Agnes", attemptOrdinal: 0 }),
    }));
    expect(reviewProviderAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewRunId_attemptKey: { reviewRunId: "run-1", attemptKey: "primary:1" } },
      data: expect.objectContaining({ status: "failed", outcome: "transport_failure", errorClass: "ETIMEDOUT" }),
    }));
  });

  it("does not reopen a terminal attempt during replay", async () => {
    const { beginProviderAttempt } = await import("../src/services/durableScanState");
    reviewProviderAttempt.findUnique.mockResolvedValue({ status: "failed" });

    await expect(beginProviderAttempt({
      reviewRunId: "run-1",
      attemptKey: "primary:1",
      attemptOrdinal: 0,
      provider: "Agnes",
      model: "agnes-2.0-flash",
      maxIterations: 2,
    })).resolves.toBe(false);
    expect(reviewProviderAttempt.create).not.toHaveBeenCalled();
  });

  it("replays artifacts and checkpoints idempotently with content hashes", async () => {
    const { persistReviewArtifact, persistReviewCheckpoint } = await import("../src/services/durableScanState");
    const state = {
      version: 1,
      runId: "run-1",
      checkpointId: "__run",
      commitHash: "commit",
      diffHash: "diff",
      reviewConfigHash: "config",
      messages: [{ role: "user", content: "prompt" }],
      loopCount: 1,
      maxIterations: 2,
      provider: "Agnes",
      model: "agnes-2.0-flash",
      writtenAt: 1_700_000_000_000,
    };

    await persistReviewArtifact({
      reviewRunId: "run-1",
      artifactKey: "deterministic:__run",
      kind: "deterministic_checks",
      content: { checks: [{ source: "lint", status: "passed" }] },
    });
    await persistReviewArtifact({
      reviewRunId: "run-1",
      artifactKey: "deterministic:__run",
      kind: "deterministic_checks",
      content: { checks: [{ source: "lint", status: "passed" }] },
    });
    await persistReviewCheckpoint(state);

    expect(reviewArtifact.upsert).toHaveBeenCalledTimes(2);
    expect(reviewArtifact.upsert.mock.calls[0][0]).toEqual(reviewArtifact.upsert.mock.calls[1][0]);
    expect(reviewCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { reviewRunId_checkpointId: { reviewRunId: "run-1", checkpointId: "__run" } },
      create: expect.objectContaining({ version: 1, loopCount: 1, stateHash: expect.any(String) }),
    }));
  });

  it("reads all durable evidence for a run in chronological order", async () => {
    const { readDurableScanEvidence } = await import("../src/services/durableScanState");
    await expect(readDurableScanEvidence("run-1")).resolves.toEqual({
      providerAttempts: [{ attemptKey: "primary" }],
      artifacts: [{ artifactKey: "checks" }],
      checkpoints: [{ checkpointId: "__run" }],
    });
    expect(reviewProviderAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reviewRunId: "run-1" } }));
  });
});
