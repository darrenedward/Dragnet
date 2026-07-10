import { describe, expect, it } from "vitest";
import { computeStability, computeWeightedStability, STABILITY_RATING_THRESHOLD, STABILITY_MIN_ROUNDS, STABILITY_WEIGHT_THRESHOLD } from "../src/lib/stabilityScore";

function run(runId: string, rating: number | null, newFindingsCount: number, model: string | null = "claude-opus"): import("../src/lib/stabilityScore").RatingTrendEntry {
  return { runId, rating, completedAt: new Date(), commitHash: "h", newFindingsCount, model };
}

function fakeWeight(model: string | null | undefined): number {
  if (!model) return 0.5;
  if (model.includes("opus")) return 1.0;
  if (model.includes("sonnet")) return 0.9;
  if (model.includes("haiku")) return 0.7;
  if (model.includes("gpt-4o-mini")) return 0.5;
  if (model.includes("gpt-4o")) return 0.9;
  if (model.includes("ollama")) return 0.4;
  return 0.5;
}

describe("computeStability", () => {
  it("returns readyToMerge: false for dirty pattern [dirty, clean, clean]", () => {
    const result = computeStability([
      run("r1", 5, 2),
      run("r2", 10, 0),
      run("r3", 9, 0),
    ]);
    expect(result.readyToMerge).toBe(false);
    expect(result.consecutiveCleanRounds).toBe(2);
    expect(result.lastUnstableRunId).toBe("r1");
  });

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

describe("computeWeightedStability", () => {
  it("returns correct weighted score for high-trust models", () => {
    const result = computeWeightedStability(
      [
        run("r1", 9, 0, "claude-opus-4-7"),
        run("r2", 10, 0, "claude-sonnet-4-6"),
        run("r3", 8, 0, "claude-sonnet-4-6"),
      ],
      fakeWeight,
    );
    expect(result.weightedStability).toBeCloseTo(1.0 + 0.9 + 0.9, 5);
    expect(result.readyToMerge).toBe(true);
  });

  it("returns readyToMerge: false for low weighted score", () => {
    const result = computeWeightedStability(
      [
        run("r1", 10, 0, "ollama/llama3"),
        run("r2", 9, 0, "ollama/llama3"),
        run("r3", 8, 0, "ollama/llama3"),
      ],
      fakeWeight,
    );
    expect(result.weightedStability).toBeCloseTo(0.4 + 0.4 + 0.4, 5);
    expect(result.readyToMerge).toBe(false);
  });

  it("stops at first unclean round", () => {
    const result = computeWeightedStability(
      [
        run("r1", 9, 0, "claude-sonnet-4-6"),
        run("r2", 5, 0, "claude-opus-4-7"),
        run("r3", 9, 0, "claude-sonnet-4-6"),
      ],
      fakeWeight,
    );
    expect(result.weightedStability).toBeCloseTo(0.9, 5);
    expect(result.readyToMerge).toBe(false);
  });

  it("stops at round with new findings", () => {
    const result = computeWeightedStability(
      [
        run("r1", 9, 0, "claude-sonnet-4-6"),
        run("r2", 9, 2, "claude-sonnet-4-6"),
        run("r3", 9, 0, "claude-sonnet-4-6"),
      ],
      fakeWeight,
    );
    expect(result.weightedStability).toBeCloseTo(0.9, 5);
    expect(result.readyToMerge).toBe(false);
  });

  it("returns 0 for empty trend", () => {
    const result = computeWeightedStability([], fakeWeight);
    expect(result.weightedStability).toBe(0);
    expect(result.readyToMerge).toBe(false);
  });

  it("handles null rating as unclean", () => {
    const result = computeWeightedStability(
      [
        run("r1", 8, 0, "claude-sonnet-4-6"),
        run("r2", null, 0, "claude-sonnet-4-6"),
        run("r3", 9, 0, "claude-sonnet-4-6"),
      ],
      fakeWeight,
    );
    expect(result.weightedStability).toBeCloseTo(0.9, 5);
    expect(result.readyToMerge).toBe(false);
  });

  it("honours custom weight threshold", () => {
    const result = computeWeightedStability(
      [
        run("r1", 9, 0, "claude-sonnet-4-6"),
        run("r2", 10, 0, "gpt-4o-mini"),
      ],
      fakeWeight,
      { weightThreshold: 1.0 },
    );
    expect(result.weightedStability).toBeCloseTo(0.9 + 0.5, 5);
    expect(result.readyToMerge).toBe(true);
  });

  it("low-trust model needs more rounds to reach merge-ready", () => {
    const lowTrust = [
      run("r1", 9, 0, "gpt-4o-mini"),
      run("r2", 10, 0, "gpt-4o-mini"),
      run("r3", 8, 0, "gpt-4o-mini"),
      run("r4", 9, 0, "gpt-4o-mini"),
      run("r5", 10, 0, "gpt-4o-mini"),
    ];
    const lowResult = computeWeightedStability(lowTrust, fakeWeight);
    expect(lowResult.weightedStability).toBeCloseTo(0.5 * 5, 5);
    expect(lowResult.readyToMerge).toBe(true);

    const notEnough = computeWeightedStability(lowTrust.slice(0, 4), fakeWeight);
    expect(notEnough.weightedStability).toBeCloseTo(0.5 * 4, 5);
    expect(notEnough.readyToMerge).toBe(false);
  });

  it("uses env DRAGNET_WEIGHT_THRESHOLD when no option passed", () => {
    const prev = process.env.DRAGNET_WEIGHT_THRESHOLD;
    process.env.DRAGNET_WEIGHT_THRESHOLD = "0.5";
    try {
      const result = computeWeightedStability(
        [run("r1", 10, 0, "gpt-4o-mini")],
        fakeWeight,
      );
      expect(result.weightedStability).toBe(0.5);
      expect(result.readyToMerge).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DRAGNET_WEIGHT_THRESHOLD;
      else process.env.DRAGNET_WEIGHT_THRESHOLD = prev;
    }
  });

  it("exports STABILITY_WEIGHT_THRESHOLD default", () => {
    expect(STABILITY_WEIGHT_THRESHOLD).toBe(2.5);
  });
});
