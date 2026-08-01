import { describe, expect, it } from "vitest";

import {
  FINISH_RESERVE_ITERATIONS,
  SUBMIT_REVIEW_TOOL_CHOICE,
  shouldForceSubmitPath,
  finishPathNudgeMessage,
  finishPathToolChoice,
  formatAttemptEndConsoleLog,
  formatAttemptEndReviewLog,
} from "../src/lib/agenticFinish";
import {
  DEFAULT_MAX_ITERATIONS,
  MAX_ITERATIONS_BOUNDS,
  resolveMaxIterations,
} from "../src/lib/llmPresets/types";

describe("shouldForceSubmitPath", () => {
  it("does not force while budget has free non-reserved iterations", () => {
    // budget 4, reserve 1 → force only on iteration 4
    expect(shouldForceSubmitPath(1, 4, false)).toBe(false);
    expect(shouldForceSubmitPath(2, 4, false)).toBe(false);
    expect(shouldForceSubmitPath(3, 4, false)).toBe(false);
  });

  it("forces on the reserved final iteration when no submit yet", () => {
    expect(shouldForceSubmitPath(4, 4, false)).toBe(true);
    expect(shouldForceSubmitPath(8, 8, false)).toBe(true);
  });

  it("never forces after submitReview already succeeded", () => {
    expect(shouldForceSubmitPath(4, 4, true)).toBe(false);
    expect(shouldForceSubmitPath(1, 4, true)).toBe(false);
  });

  it("forces earlier when reserve > 1", () => {
    expect(shouldForceSubmitPath(3, 4, false, 2)).toBe(true);
    expect(shouldForceSubmitPath(2, 4, false, 2)).toBe(false);
  });

  it("exports reserve default of 1", () => {
    expect(FINISH_RESERVE_ITERATIONS).toBe(1);
  });
});

describe("finish path payloads", () => {
  it("tool_choice targets submitReview only", () => {
    expect(finishPathToolChoice()).toEqual(SUBMIT_REVIEW_TOOL_CHOICE);
    expect(finishPathToolChoice().function.name).toBe("submitReview");
  });

  it("nudge message demands submitReview and forbids other tools", () => {
    const msg = finishPathNudgeMessage();
    expect(msg).toMatch(/submitReview/i);
    expect(msg).toMatch(/not call any other tools/i);
  });
});

describe("attempt end log formatting", () => {
  const base = {
    provider: "Primary",
    outcome: "quality_failure",
    iterationsUsed: 4,
    maxIterations: 4,
    submitReview: false,
    malformedCount: 1,
    finalizerAttempted: true,
  };

  it("console line includes iterations, submitReview, malformed, finalizerAttempted", () => {
    const line = formatAttemptEndConsoleLog({
      ...base,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.001234,
    });
    expect(line).toContain("iterations=4/4");
    expect(line).toContain("submitReview=false");
    expect(line).toContain("malformed=1");
    expect(line).toContain("finalizerAttempted=true");
    expect(line).toContain("outcome=quality_failure");
  });

  it("review log line includes the same core flags", () => {
    const line = formatAttemptEndReviewLog(base);
    expect(line).toContain("iterations=4/4");
    expect(line).toContain("submitReview=false");
    expect(line).toContain("finalizerAttempted=true");
    expect(line).toContain("malformed=1");
  });
});

describe("maxIterations floor for chat presets", () => {
  it("floor is high enough that tool-then-submit is realistic (min >= 4)", () => {
    expect(MAX_ITERATIONS_BOUNDS.min).toBeGreaterThanOrEqual(4);
    expect(MAX_ITERATIONS_BOUNDS.max).toBe(32);
  });

  it("resolveMaxIterations clamps absurdly low values up to the floor", () => {
    expect(resolveMaxIterations({ maxIterations: 1 })).toBe(MAX_ITERATIONS_BOUNDS.min);
    expect(resolveMaxIterations({ maxIterations: 2 })).toBe(MAX_ITERATIONS_BOUNDS.min);
    expect(resolveMaxIterations({ maxIterations: 3 })).toBe(MAX_ITERATIONS_BOUNDS.min);
  });

  it("resolveMaxIterations keeps in-bounds values", () => {
    expect(resolveMaxIterations({ maxIterations: 4 })).toBe(4);
    expect(resolveMaxIterations({ maxIterations: 8 })).toBe(8);
    expect(resolveMaxIterations({})).toBe(DEFAULT_MAX_ITERATIONS);
  });
});
