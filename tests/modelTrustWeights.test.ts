import { describe, expect, it, beforeEach } from "vitest";
import { lookupTrustWeight, clearWeightCache, STABILITY_WEIGHT_THRESHOLD } from "../src/lib/modelTrustWeights";

beforeEach(() => {
  clearWeightCache();
});

describe("lookupTrustWeight", () => {
  it("returns exact weight for known model (Claude Opus 4.7)", () => {
    expect(lookupTrustWeight("claude-opus-4-7")).toBe(1.0);
  });

  it("returns exact weight for known model (Sonnet 4.6)", () => {
    expect(lookupTrustWeight("claude-sonnet-4-6")).toBe(0.9);
  });

  it("returns exact weight for GPT-4o", () => {
    expect(lookupTrustWeight("gpt-4o")).toBe(0.9);
  });

  it("returns exact weight for GPT-4o-mini", () => {
    expect(lookupTrustWeight("gpt-4o-mini")).toBe(0.5);
  });

  it("returns prefix match for model with version suffix", () => {
    expect(lookupTrustWeight("gpt-4o-2026-05-13")).toBe(0.9);
  });

  it("returns prefix match for claude-sonnet with version", () => {
    expect(lookupTrustWeight("claude-sonnet-4-6-20260513")).toBe(0.9);
  });

  it("returns prefix match for minimax with version", () => {
    expect(lookupTrustWeight("minimax-m3-123b")).toBe(0.7);
  });

  it("returns 0.4 for plain \"ollama\" identifier (exact seeded-table match)", () => {
    expect(lookupTrustWeight("ollama")).toBe(0.4);
  });

  it("returns 0.4 for plain \"lm-studio\" identifier (exact seeded-table match)", () => {
    expect(lookupTrustWeight("lm-studio")).toBe(0.4);
  });

  it("returns 0.6 for ollama/llama3.2 (capability-based via llama prefix)", () => {
    expect(lookupTrustWeight("ollama/llama3.2")).toBe(0.6);
  });

  it("returns 0.5 for unknown models", () => {
    expect(lookupTrustWeight("unknown-custom-model")).toBe(0.5);
  });

  it("returns 0.5 for empty string", () => {
    expect(lookupTrustWeight("")).toBe(0.5);
  });

  it("returns 0.5 for null", () => {
    expect(lookupTrustWeight(null)).toBe(0.5);
  });

  it("handles provider/ prefix in model name", () => {
    expect(lookupTrustWeight("anthropic/claude-opus-4-7")).toBe(1.0);
  });

  it("handles OpenRouter-style names", () => {
    expect(lookupTrustWeight("openai/gpt-4o-mini")).toBe(0.5);
  });

  it("returns 0.5 for undefined", () => {
    expect(lookupTrustWeight(undefined)).toBe(0.5);
  });

  it("honours env override for model weight", () => {
    const prev = process.env.DRAGNET_MODEL_TRUST_GPT_5;
    process.env.DRAGNET_MODEL_TRUST_GPT_5 = "0.5";
    clearWeightCache();
    expect(lookupTrustWeight("gpt-5")).toBe(0.5);
    if (prev === undefined) {
      delete process.env.DRAGNET_MODEL_TRUST_GPT_5;
    } else {
      process.env.DRAGNET_MODEL_TRUST_GPT_5 = prev;
    }
    clearWeightCache();
  });

  it("honours env override for previously unknown model", () => {
    const prev = process.env.DRAGNET_MODEL_TRUST_MY_CUSTOM_MODEL;
    process.env.DRAGNET_MODEL_TRUST_MY_CUSTOM_MODEL = "0.85";
    clearWeightCache();
    expect(lookupTrustWeight("my-custom-model")).toBe(0.85);
    if (prev === undefined) {
      delete process.env.DRAGNET_MODEL_TRUST_MY_CUSTOM_MODEL;
    } else {
      process.env.DRAGNET_MODEL_TRUST_MY_CUSTOM_MODEL = prev;
    }
    clearWeightCache();
  });

  it("exports STABILITY_WEIGHT_THRESHOLD with default 2.5", () => {
    expect(STABILITY_WEIGHT_THRESHOLD).toBe(2.5);
  });

  it("env override wins for Ollama model name", () => {
    const prev = process.env.DRAGNET_MODEL_TRUST_OLLAMA;
    process.env.DRAGNET_MODEL_TRUST_OLLAMA = "0.9";
    clearWeightCache();
    expect(lookupTrustWeight("ollama/llama-3.1")).toBe(0.9);
    if (prev === undefined) {
      delete process.env.DRAGNET_MODEL_TRUST_OLLAMA;
    } else {
      process.env.DRAGNET_MODEL_TRUST_OLLAMA = prev;
    }
    clearWeightCache();
  });

  it("env override wins for LM Studio model name", () => {
    const prev = process.env.DRAGNET_MODEL_TRUST_LMSTUDIO;
    process.env.DRAGNET_MODEL_TRUST_LMSTUDIO = "0.7";
    clearWeightCache();
    expect(lookupTrustWeight("lmstudio/llama")).toBe(0.7);
    if (prev === undefined) {
      delete process.env.DRAGNET_MODEL_TRUST_LMSTUDIO;
    } else {
      process.env.DRAGNET_MODEL_TRUST_LMSTUDIO = prev;
    }
    clearWeightCache();
  });
});
