import { describe, expect, it } from "vitest";
import { evaluateReviewStale } from "../src/lib/reviewStale";
import { isMergeReady } from "../src/lib/mergeReady";

describe("evaluateReviewStale", () => {
  it("is fresh when tip and diff match", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "abc123",
        tipCommitHash: "abc123",
        runDiffHash: "diff-aa",
        currentDiffHash: "diff-aa",
      }),
    ).toEqual({ stale: false, reason: null });
  });

  it("marks tip_mismatch when run commit differs from PR tip", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "old-tip",
        tipCommitHash: "new-tip",
        runDiffHash: "diff-aa",
        currentDiffHash: "diff-aa",
      }),
    ).toEqual({ stale: true, reason: "tip_mismatch" });
  });

  it("marks diff_changed when diff hash moved (same tip)", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "abc123",
        tipCommitHash: "abc123",
        runDiffHash: "diff-old",
        currentDiffHash: "diff-new",
      }),
    ).toEqual({ stale: true, reason: "diff_changed" });
  });

  it("prefers tip_mismatch when both tip and diff disagree", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "old-tip",
        tipCommitHash: "new-tip",
        runDiffHash: "diff-old",
        currentDiffHash: "diff-new",
      }),
    ).toEqual({ stale: true, reason: "tip_mismatch" });
  });

  it("does not mark stale on empty run diff hash alone", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "abc123",
        tipCommitHash: "abc123",
        runDiffHash: "",
        currentDiffHash: "diff-new",
      }),
    ).toEqual({ stale: false, reason: null });
  });

  it("does not mark tip_mismatch when either tip hash is empty", () => {
    expect(
      evaluateReviewStale({
        runCommitHash: "",
        tipCommitHash: "new-tip",
        runDiffHash: "diff-aa",
        currentDiffHash: "diff-aa",
      }),
    ).toEqual({ stale: false, reason: null });
  });
});

describe("isMergeReady + tip stale", () => {
  const ready = {
    status: "completed",
    outcome: "reviewed",
    rating: 9,
    reliability: "complete",
    refused: false,
  };

  it("blocks merge when stale tip_mismatch", () => {
    const r = isMergeReady({
      ...ready,
      stale: true,
      staleReason: "tip_mismatch",
    });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("stale");
    expect(r.message).toMatch(/tip/i);
  });

  it("blocks merge when stale diff_changed", () => {
    const r = isMergeReady({
      ...ready,
      stale: true,
      staleReason: "diff_changed",
    });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("stale");
    expect(r.message).toMatch(/stale|diff|revision/i);
  });
});
