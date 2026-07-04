import { describe, expect, it } from "vitest";
import { computeStability, STABILITY_RATING_THRESHOLD, STABILITY_MIN_ROUNDS } from "../src/lib/stabilityScore";

function run(runId: string, rating: number | null, newFindingsCount: number) {
  return { runId, rating, completedAt: new Date(), commitHash: "h", newFindingsCount };
}

describe("computeStability", () => {
  it("returns readyToMerge: true for 3+ consecutive clean rounds", () => {
    const result = computeStability([
      run("r1", 9, 0),
      run("r2", 10, 0),
      run("r3", 8, 0),
    ]);
    expect(result.readyToMerge).toBe(true);
    expect(result.consecutiveCleanRounds).toBe(3);
    expect(result.lastUnstableRunId).toBeNull();
  });

  it("returns readyToMerge: false for 2 consecutive clean rounds (< min rounds)", () => {
    const result = computeStability([
      run("r1", 9, 0),
      run("r2", 10, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(2);
  });

  it("returns readyToMerge: false for single-scan PR", () => {
    const result = computeStability([
      run("r1", 10, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(1);
  });

  it("stops at a run with new findings even if rating is high", () => {
    const result = computeStability([
      run("r1", 9, 0),
      run("r2", 9, 2),
      run("r3", 9, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(1);
    expect(result.lastUnstableRunId).toBe("r2");
  });

  it("stops at a run with low rating", () => {
    const result = computeStability([
      run("r1", 10, 0),
      run("r2", 8, 0),
      run("r3", 5, 0),
      run("r4", 9, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(1);
    expect(result.lastUnstableRunId).toBe("r3");
  });

  it("handles null rating as unstable", () => {
    const result = computeStability([
      run("r1", 8, 0),
      run("r2", null, 0),
      run("r3", 8, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(1);
    expect(result.lastUnstableRunId).toBe("r2");
  });

  it("returns 0 clean rounds for empty input", () => {
    const result = computeStability([]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(0);
    expect(result.lastUnstableRunId).toBeNull();
  });

  it("respects custom threshold and min rounds", () => {
    const trend = [
      run("r1", 7, 0),
      run("r2", 9, 0),
      run("r3", 8, 0),
    ];
    const defaultResult = computeStability(trend);
    expect(defaultResult.readyToMerge).toBe(false);
    expect(defaultResult.consecutiveCleanRounds).toBe(2);
    expect(defaultResult.lastUnstableRunId).toBe("r1");

    const customResult = computeStability(trend, { ratingThreshold: 9, minRounds: 2 });
    expect(customResult.readyToMerge).toBe(false);
    expect(customResult.consecutiveCleanRounds).toBe(0);
    expect(customResult.lastUnstableRunId).toBe("r3");
  });

  it("walks latest-first: only the most recent runs matter", () => {
    const result = computeStability([
      run("r1", 3, 2),
      run("r2", 4, 1),
      run("r3", 10, 0),
      run("r4", 9, 0),
      run("r5", 8, 0),
    ]);
    expect(result.readyToMerge).toBe(true);
    expect(result.consecutiveCleanRounds).toBe(3);
  });
});
