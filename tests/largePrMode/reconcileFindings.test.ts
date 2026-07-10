import { describe, expect, it } from "vitest";
import { planReconcile } from "../../src/services/largePrReview";

describe("planReconcile", () => {
  it("matches a current finding to a prior finding by fingerprint", () => {
    const fp = "abc123def456abcd";
    const current = [
      { id: "new-1", fingerprint: fp, sourceHashAtInsert: "hash-r2" },
    ];
    const prior = [
      { id: "prior-1", fingerprint: fp },
    ];

    const plan = planReconcile(current, prior);

    expect(plan.matchedNewIds).toEqual(["new-1"]);
    expect(plan.matchedPriorUpdates).toEqual([
      { id: "prior-1", sourceHashAtInsert: "hash-r2" },
    ]);
    expect(plan.unmatchedPriorIds).toEqual([]);
  });

  it("carries the current run's sourceHash onto the prior row (snapshot refresh)", () => {
    // Critical: when the prior matches a new finding, the prior's
    // sourceHashAtInsert must be updated to the CURRENT symbol's hash, so the
    // next round's reconcile compares against the latest snapshot — not the
    // one from when the finding was first detected.
    const current = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-after-fix-attempt" },
    ];
    const prior = [
      { id: "prior-1", fingerprint: "fp-x" },
    ];

    const plan = planReconcile(current, prior);

    expect(plan.matchedPriorUpdates[0].sourceHashAtInsert).toBe("hash-after-fix-attempt");
  });

  it("treats a current finding with no prior match as new (no plan entry)", () => {
    const current = [
      { id: "new-1", fingerprint: "fp-new", sourceHashAtInsert: "h1" },
    ];
    const prior: Array<{ id: string; fingerprint: string | null }> = [];

    const plan = planReconcile(current, prior);

    expect(plan.matchedNewIds).toEqual([]);
    expect(plan.matchedPriorUpdates).toEqual([]);
    expect(plan.unmatchedPriorIds).toEqual([]);
    // Caller derives newFindings = current.length - matchedNewIds.length.
  });

  it("treats a prior finding with no current match as unmatched (needs resolved-vs-regression check)", () => {
    const current: Array<{ id: string; fingerprint: string | null; sourceHashAtInsert: string | null }> = [];
    const prior = [
      { id: "prior-1", fingerprint: "fp-x" },
    ];

    const plan = planReconcile(current, prior);

    expect(plan.unmatchedPriorIds).toEqual(["prior-1"]);
    expect(plan.matchedNewIds).toEqual([]);
  });

  it("treats a prior with null fingerprint as unmatched (cannot match without identity)", () => {
    // Should be rare — every modern finding gets a fingerprint at insert.
    // But legacy rows or schema-skips shouldn't crash the reconcile.
    const current: Array<{ id: string; fingerprint: string | null; sourceHashAtInsert: string | null }> = [];
    const prior = [{ id: "legacy-1", fingerprint: null }];

    const plan = planReconcile(current, prior);

    expect(plan.unmatchedPriorIds).toEqual(["legacy-1"]);
  });

  it("matches multiple priors to multiple currents by fingerprint", () => {
    const current = [
      { id: "new-1", fingerprint: "fp-a", sourceHashAtInsert: "h-a" },
      { id: "new-2", fingerprint: "fp-b", sourceHashAtInsert: "h-b" },
      { id: "new-3", fingerprint: "fp-c", sourceHashAtInsert: "h-c" },
    ];
    const prior = [
      { id: "prior-1", fingerprint: "fp-a" },
      { id: "prior-2", fingerprint: "fp-b" },
      { id: "prior-3", fingerprint: "fp-z" }, // unmatched — no current has fp-z
    ];

    const plan = planReconcile(current, prior);

    expect(plan.matchedNewIds.sort()).toEqual(["new-1", "new-2"]);
    expect(plan.matchedPriorUpdates.map((u) => u.id).sort()).toEqual(["prior-1", "prior-2"]);
    expect(plan.unmatchedPriorIds).toEqual(["prior-3"]);
  });

  it("does not double-match: one current finding cannot match two priors", () => {
    // If two prior findings share a fingerprint (which intra-run dedup should
    // have prevented, but defend in depth), only one prior gets bumped.
    const current = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: "h1" },
    ];
    const prior = [
      { id: "prior-1", fingerprint: "fp-x" },
      { id: "prior-2", fingerprint: "fp-x" },
    ];

    const plan = planReconcile(current, prior);

    expect(plan.matchedNewIds).toEqual(["new-1"]);
    expect(plan.matchedPriorUpdates).toHaveLength(1);
    // The other prior falls through to unmatched.
    expect(plan.unmatchedPriorIds).toHaveLength(1);
  });

  it("ignores current findings with null fingerprint (cannot be matched)", () => {
    // Defensive: should not happen since every finding gets a fingerprint at
    // insert, but a null fingerprint on the CURRENT side means we can't match
    // it to anything, and the prior stays in its prior state.
    const current = [
      { id: "new-1", fingerprint: null, sourceHashAtInsert: "h1" },
    ];
    const prior = [{ id: "prior-1", fingerprint: "fp-x" }];

    const plan = planReconcile(current, prior);

    expect(plan.matchedNewIds).toEqual([]);
    expect(plan.unmatchedPriorIds).toEqual(["prior-1"]);
  });

  it("returns empty plan when both sides are empty", () => {
    const plan = planReconcile([], []);
    expect(plan).toEqual({
      matchedNewIds: [],
      matchedPriorUpdates: [],
      unmatchedPriorIds: [],
    });
  });
});
