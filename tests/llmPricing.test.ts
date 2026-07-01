import { afterEach, describe, expect, it } from "vitest";
import { computeCost, lookupPrice, PRICING_TABLE } from "../src/lib/llmPricing";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Restore env between tests so env-override tests don't leak.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("DRAGNET_PRICE_") && !(k in ORIGINAL_ENV)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (k.startsWith("DRAGNET_PRICE_")) process.env[k] = v;
  }
});

describe("lookupPrice — exact match", () => {
  it("returns gpt-5 entry for 'gpt-5'", () => {
    expect(lookupPrice("gpt-5")).toEqual({ inputPer1M: 5, outputPer1M: 15, currency: "USD" });
  });

  it("is case-insensitive", () => {
    expect(lookupPrice("GPT-5").inputPer1M).toBe(5);
    expect(lookupPrice("Claude-Opus").inputPer1M).toBe(15);
  });
});

describe("lookupPrice — prefix match", () => {
  it("drops provider prefix (openai/gpt-5 → gpt-5)", () => {
    expect(lookupPrice("openai/gpt-5").inputPer1M).toBe(5);
  });

  it("strips version numbers (gpt-5.2 → gpt-5)", () => {
    expect(lookupPrice("gpt-5.2").inputPer1M).toBe(5);
  });

  it("strips multi-segment version (nemotron-3-ultra-550b-a55b → nemotron)", () => {
    // nvidia/ prefix is dropped; numeric + parameter-count segments stripped
    const p = lookupPrice("nvidia/nemotron-3-ultra-550b-a55b");
    expect(p.inputPer1M).toBeGreaterThan(0);
  });

  it("matches claude-sonnet-4.5 to claude-sonnet", () => {
    expect(lookupPrice("anthropic/claude-sonnet-4.5").inputPer1M).toBe(3);
  });

  it("matches glm-5-turbo to glm-turbo (longest prefix wins)", () => {
    expect(lookupPrice("glm-5-turbo").inputPer1M).toBe(0.07);
  });
});

describe("lookupPrice — free-tier short-circuit", () => {
  it("returns $0 for OpenRouter :free suffix", () => {
    expect(lookupPrice("openai/gpt-oss-120b:free")).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      currency: "USD",
    });
  });

  it("returns $0 for ollama models", () => {
    expect(lookupPrice("ollama/mxbai-embed-large:latest").inputPer1M).toBe(0);
  });

  it("returns $0 for LM Studio models", () => {
    expect(lookupPrice("ornith-1.0-9b").inputPer1M).toBe(0); // via lm-studio endpoint
  });
});

describe("lookupPrice — unknown model fallback", () => {
  it("returns $0 for completely unknown model", () => {
    expect(lookupPrice("future-model-x").inputPer1M).toBe(0);
  });

  it("returns $0 for empty/null", () => {
    expect(lookupPrice("").inputPer1M).toBe(0);
  });
});

describe("lookupPrice — env override", () => {
  it("env override beats seeded table", () => {
    process.env.DRAGNET_PRICE_GPT_5_IN = "999";
    process.env.DRAGNET_PRICE_GPT_5_OUT = "888";
    expect(lookupPrice("gpt-5").inputPer1M).toBe(999);
    expect(lookupPrice("gpt-5").outputPer1M).toBe(888);
  });

  it("env override works for unknown models", () => {
    process.env.DRAGNET_PRICE_FUTURE_MODEL_X_IN = "1.5";
    process.env.DRAGNET_PRICE_FUTURE_MODEL_X_OUT = "2.5";
    expect(lookupPrice("future-model-x").inputPer1M).toBe(1.5);
    expect(lookupPrice("future-model-x").outputPer1M).toBe(2.5);
  });
});

describe("computeCost — arithmetic", () => {
  it("1M prompt tokens at $5/1M = $5", () => {
    const { costUsd } = computeCost("gpt-5", 1_000_000, 0);
    expect(costUsd).toBe(5);
  });

  it("1M completion tokens at $15/1M = $15", () => {
    const { costUsd } = computeCost("gpt-5", 0, 1_000_000);
    expect(costUsd).toBe(15);
  });

  it("mixed tokens produce expected sum", () => {
    const { costUsd } = computeCost("gpt-5", 200_000, 100_000); // $1 + $1.5
    expect(costUsd).toBe(2.5);
  });

  it("free models always return 0", () => {
    const { costUsd } = computeCost("openrouter/openai/gpt-oss-120b:free", 5_000_000, 1_000_000);
    expect(costUsd).toBe(0);
  });

  it("unknown models return 0 with warning", () => {
    const { costUsd } = computeCost("totally-unknown-model", 1_000_000, 1_000_000);
    expect(costUsd).toBe(0);
  });

  it("null/undefined tokens treated as 0", () => {
    const { costUsd } = computeCost("gpt-5", null as any, undefined as any);
    expect(costUsd).toBe(0);
  });

  it("returns the price alongside cost for caller use", () => {
    const { price } = computeCost("claude-sonnet-4.6", 0, 0);
    expect(price.inputPer1M).toBe(3);
  });
});

describe("PRICING_TABLE — sanity", () => {
  it("all entries have currency USD", () => {
    for (const price of Object.values(PRICING_TABLE)) {
      expect(price.currency).toBe("USD");
    }
  });

  it("all entries have non-negative numeric prices", () => {
    for (const price of Object.values(PRICING_TABLE)) {
      expect(typeof price.inputPer1M).toBe("number");
      expect(typeof price.outputPer1M).toBe("number");
      expect(price.inputPer1M).toBeGreaterThanOrEqual(0);
      expect(price.outputPer1M).toBeGreaterThanOrEqual(0);
    }
  });
});
