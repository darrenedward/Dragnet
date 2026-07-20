import { describe, it, expect } from "vitest";
import { buildTokensUsed, type SkepticTokensUsed } from "../src/services/reviewService";
import type { ProviderAttempt } from "../src/lib/failureClassifier";

/**
 * buildTokensUsed tests for the skeptic telemetry extension (issue #73).
 *
 * The skeptic call's tokens + outcome should:
 *  1. Be folded into the totals (totalCostUsd, total*Tokens)
 *  2. Appear as a pseudo-provider row in `providers[]`
 *  3. Be exposed verbatim under `skeptic` for the UI breakdown
 *
 * Without a skeptic argument, the function should produce a payload
 * with `skeptic: null` so the existing UI surfaces render "no skeptic"
 * correctly.
 */

function attempt(opts: Partial<ProviderAttempt>): ProviderAttempt {
  return {
    provider: "primary",
    model: "primary-model",
    iterationsUsed: 4,
    maxIterations: 8,
    submitReviewCalled: true,
    rating: 7,
    error: null,
    outcome: "success",
    promptTokens: 1000,
    completionTokens: 200,
    costUsd: 0.005,
    ...opts,
  };
}

const SKEPTIC: SkepticTokensUsed = {
  providerKey: "minimax.example.com:minimax-m1",
  providerName: "Minimax",
  endpoint: "https://minimax.example.com/v1",
  model: "minimax-m1",
  promptTokens: 500,
  completionTokens: 50,
  costUsd: 0.001,
  outcomes: {
    confirmed: 3,
    downgraded: 1,
    rejected: 2,
    skipped: 0,
    error: 0,
  },
  outcome: "skeptic_reject",
};

describe("buildTokensUsed — skeptic extension (issue #73)", () => {
  it("returns skeptic: null when no skeptic telemetry provided", () => {
    const result = buildTokensUsed([attempt({})]);
    expect(result.skeptic).toBeNull();
    expect(result.providers).toHaveLength(1);
    expect(result.totalPromptTokens).toBe(1000);
    expect(result.totalCompletionTokens).toBe(200);
    expect(result.totalCostUsd).toBe(0.005);
  });

  it("folds skeptic tokens into totals", () => {
    const result = buildTokensUsed([attempt({})], SKEPTIC);
    expect(result.totalPromptTokens).toBe(1500); // 1000 + 500
    expect(result.totalCompletionTokens).toBe(250); // 200 + 50
    expect(result.totalCostUsd).toBeCloseTo(0.006, 6); // 0.005 + 0.001
  });

  it("appends skeptic pseudo-row to providers[] withskeptic_* outcome", () => {
    const result = buildTokensUsed([attempt({})], SKEPTIC);
    expect(result.providers).toHaveLength(2);
    const skepticRow = result.providers[1];
    expect(skepticRow.name).toBe("Minimax (skeptic)");
    expect(skepticRow.outcome).toBe("skeptic_reject");
    expect(skepticRow.promptTokens).toBe(500);
    expect(skepticRow.completionTokens).toBe(50);
    expect(skepticRow.costUsd).toBe(0.001);
    expect(skepticRow.iterationsUsed).toBe(1);
    expect(skepticRow.maxIterations).toBe(1);
  });

  it("exposes per-verdict outcome breakdown under skeptic.outcomes", () => {
    const result = buildTokensUsed([attempt({})], SKEPTIC);
    expect(result.skeptic).toEqual(SKEPTIC);
    expect(result.skeptic?.outcomes).toEqual({
      confirmed: 3,
      downgraded: 1,
      rejected: 2,
      skipped: 0,
      error: 0,
    });
  });

  it("handles null skeptic explicitly (explicit no-skeptic case)", () => {
    const result = buildTokensUsed([attempt({})], null);
    expect(result.skeptic).toBeNull();
    expect(result.providers).toHaveLength(1);
  });

  it("skeptic row appears even with zero primary attempts", () => {
    const result = buildTokensUsed([], SKEPTIC);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].name).toBe("Minimax (skeptic)");
    expect(result.totalPromptTokens).toBe(500);
    expect(result.totalCostUsd).toBeCloseTo(0.001, 6);
  });
});
