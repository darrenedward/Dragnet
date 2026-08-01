import { describe, expect, it } from "vitest";
import {
  isMergeReady,
  checkMergeReady,
  MERGE_READY_RATING_THRESHOLD,
} from "../src/lib/isMergeReady";

/** Baseline that should pass every gate. */
function ready(overrides: Parameters<typeof isMergeReady>[0] = {}) {
  return {
    rating: 9,
    outcome: "reviewed",
    reliability: "complete",
    refused: false,
    stale: false,
    status: "completed",
    ...overrides,
  };
}

describe("isMergeReady", () => {
  it(`exports threshold ${8}`, () => {
    expect(MERGE_READY_RATING_THRESHOLD).toBe(8);
  });

  it("is merge-ready when rating >= 8, reviewed, complete, not refused, not stale", () => {
    const r = isMergeReady(ready());
    expect(r.mergeReady).toBe(true);
    expect(r.mergeBlockReason).toBeNull();
    expect(checkMergeReady(ready())).toBe(true);
  });

  it("rating exactly 8 is merge-ready", () => {
    expect(isMergeReady(ready({ rating: 8 })).mergeReady).toBe(true);
  });

  it("rating 10 is merge-ready", () => {
    expect(isMergeReady(ready({ rating: 10 })).mergeReady).toBe(true);
  });

  it("null rating is not merge-ready", () => {
    const r = isMergeReady(ready({ rating: null }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("null_rating");
    expect(r.message).toMatch(/rating|unavailable|score/i);
  });

  it("undefined rating is not merge-ready", () => {
    const r = isMergeReady(ready({ rating: undefined }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("null_rating");
  });

  it("rating 7 is not merge-ready", () => {
    const r = isMergeReady(ready({ rating: 7 }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("rating_below_threshold");
    expect(r.message).toMatch(/7/);
  });

  it("rating 0 is not merge-ready", () => {
    expect(isMergeReady(ready({ rating: 0 })).mergeReady).toBe(false);
  });

  it("skipped outcome is not merge-ready even with high rating", () => {
    const r = isMergeReady(ready({ outcome: "skipped", rating: 10 }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("skipped");
  });

  it("null outcome (legacy) with rating >= 8 can still be merge-ready", () => {
    expect(isMergeReady(ready({ outcome: null })).mergeReady).toBe(true);
  });

  it("absent reliability is merge-ready (complete when set is required, not when unset)", () => {
    expect(isMergeReady(ready({ reliability: null })).mergeReady).toBe(true);
    expect(isMergeReady(ready({ reliability: undefined })).mergeReady).toBe(true);
  });

  it("partial reliability is not merge-ready", () => {
    const r = isMergeReady(ready({ reliability: "partial" }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("reliability_incomplete");
  });

  it("incomplete_security_review reliability is not merge-ready", () => {
    const r = isMergeReady(ready({ reliability: "incomplete_security_review" }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("reliability_incomplete");
    expect(r.message).toMatch(/security|incomplete/i);
  });

  it("refused is not merge-ready even with rating 10", () => {
    const r = isMergeReady(ready({ refused: true, rating: 10 }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("refused");
  });

  it("stale is not merge-ready when staleness is known true", () => {
    const r = isMergeReady(ready({ stale: true }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("stale");
  });

  it("tip_mismatch stale message mentions tip", () => {
    const r = isMergeReady(ready({ stale: true, staleReason: "tip_mismatch" }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("stale");
    expect(r.message).toMatch(/tip/i);
  });

  it("omitted stale does not block (unknown staleness)", () => {
    const { stale: _s, ...noStale } = ready();
    expect(isMergeReady(noStale).mergeReady).toBe(true);
  });

  it("failed status is not merge-ready", () => {
    const r = isMergeReady(ready({ status: "failed", rating: 9 }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("not_finished");
  });

  it("in_progress status is not merge-ready", () => {
    const r = isMergeReady(ready({ status: "in_progress" }));
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("not_finished");
  });

  it("omitted status does not block (caller already has a finished run)", () => {
    const { status: _st, ...noStatus } = ready();
    expect(isMergeReady(noStatus).mergeReady).toBe(true);
  });

  it("empty input is not merge-ready (null rating)", () => {
    const r = isMergeReady({});
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).not.toBeNull();
  });

  it("null input is no_run", () => {
    const r = isMergeReady(null);
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("no_run");
  });

  describe("reason priority (first blocking gate wins)", () => {
    it("skipped beats low rating", () => {
      const r = isMergeReady(ready({ outcome: "skipped", rating: 3 }));
      expect(r.mergeBlockReason).toBe("skipped");
    });

    it("null rating beats stale", () => {
      const r = isMergeReady(ready({ rating: null, stale: true }));
      expect(r.mergeBlockReason).toBe("null_rating");
    });
  });
});
