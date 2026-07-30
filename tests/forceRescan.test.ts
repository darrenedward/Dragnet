import { describe, expect, it } from "vitest";
import { canForceRescan } from "@/src/lib/forceRescan";

describe("canForceRescan", () => {
  it("is true when a PR is selected and the repo is reviewable", () => {
    expect(canForceRescan({ hasSelectedPr: true, repoReviewable: true })).toBe(true);
  });

  it("stays true regardless of any local scanning flag (caller does not pass one)", () => {
    // Recovery after complete / null / failed must not require isScanning.
    expect(canForceRescan({ hasSelectedPr: true, repoReviewable: true })).toBe(true);
  });

  it("is false without a selected PR", () => {
    expect(canForceRescan({ hasSelectedPr: false, repoReviewable: true })).toBe(false);
  });

  it("is false when the repo is not reviewable (not indexed)", () => {
    expect(canForceRescan({ hasSelectedPr: true, repoReviewable: false })).toBe(false);
  });
});
