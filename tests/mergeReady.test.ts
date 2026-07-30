import { describe, it, expect } from "vitest";
import { isMergeReady, mergeReadyLabel, MERGE_RATING_THRESHOLD } from "../src/lib/mergeReady";

describe("isMergeReady", () => {
  const base = {
    status: "completed" as const,
    outcome: "reviewed" as const,
    rating: 9,
    reliability: "complete" as const,
    refused: false,
    stale: false,
  };

  it("returns mergeReady true for a clean completed run", () => {
    expect(isMergeReady(base)).toEqual({
      mergeReady: true,
      mergeBlockReason: null,
      message: null,
    });
  });

  it("treats absent reliability as complete", () => {
    expect(isMergeReady({ ...base, reliability: null }).mergeReady).toBe(true);
    expect(isMergeReady({ ...base, reliability: undefined }).mergeReady).toBe(true);
  });

  it("null rating is never merge-ready", () => {
    const r = isMergeReady({ ...base, rating: null });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("null_rating");
  });

  it("rating 7 fails; 8 and 10 pass", () => {
    expect(isMergeReady({ ...base, rating: 7 }).mergeReady).toBe(false);
    expect(isMergeReady({ ...base, rating: 7 }).mergeBlockReason).toBe("rating_below_threshold");
    expect(isMergeReady({ ...base, rating: 8 }).mergeReady).toBe(true);
    expect(isMergeReady({ ...base, rating: 10 }).mergeReady).toBe(true);
    expect(MERGE_RATING_THRESHOLD).toBe(8);
  });

  it("skipped outcome is not merge-ready", () => {
    const r = isMergeReady({ ...base, outcome: "skipped", rating: 10 });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("skipped");
  });

  it("incomplete/partial reliability fails", () => {
    expect(isMergeReady({ ...base, reliability: "incomplete_security_review" }).mergeBlockReason).toBe(
      "reliability_incomplete",
    );
    expect(isMergeReady({ ...base, reliability: "partial" }).mergeBlockReason).toBe(
      "reliability_incomplete",
    );
  });

  it("refused is not merge-ready", () => {
    const r = isMergeReady({ ...base, refused: true });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("refused");
  });

  it("stale is not merge-ready", () => {
    const r = isMergeReady({ ...base, stale: true });
    expect(r.mergeReady).toBe(false);
    expect(r.mergeBlockReason).toBe("stale");
  });

  it("no input / not finished", () => {
    expect(isMergeReady(null).mergeBlockReason).toBe("no_run");
    expect(isMergeReady({ ...base, status: "in_progress" }).mergeBlockReason).toBe("not_finished");
    expect(isMergeReady({ ...base, status: "failed" }).mergeBlockReason).toBe("not_finished");
  });

  it("mergeReadyLabel distinguishes blocked vs not ready vs ready", () => {
    expect(mergeReadyLabel(isMergeReady(base))).toBe("Merge ready");
    expect(mergeReadyLabel(isMergeReady({ ...base, rating: null }))).toContain("Not ready");
    expect(mergeReadyLabel(isMergeReady(base), "index")).toBe("Blocked at index");
  });
});
