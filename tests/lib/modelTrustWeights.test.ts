import { describe, expect, it, beforeEach } from "vitest";
import { lookupModelTrustWeight, TRUST_WEIGHTS } from "../../src/lib/modelTrustWeights";

describe("modelTrustWeights", () => {
  beforeEach(() => {
    // Clear env vars before each test
    delete process.env.DRAGNET_MODEL_TRUST_GPT_5;
    delete process.env.DRAGNET_MODEL_TRUST_CLAUDE_OPUS;
  });

  describe("lookupModelTrustWeight", () => {
    it("returns 1.0 for Claude Opus (exact match)", () => {
      expect(lookupModelTrustWeight("claude-opus")).toBe(1.0);
    });

    it("returns 0.9 for Claude Sonnet (exact match)", () => {
      expect(lookupModelTrustWeight("claude-sonnet")).toBe(0.9);
    });

    it("returns 0.7 for Claude Haiku (exact match)", () => {
      expect(lookupModelTrustWeight("claude-haiku")).toBe(0.7);
    });

    it("returns 0.9 for GPT-4o (exact match)", () => {
      expect(lookupModelTrustWeight("gpt-4o")).toBe(0.9);
    });

    it("returns 0.5 for GPT-4o-mini (exact match)", () => {
      expect(lookupModelTrustWeight("gpt-4o-mini")).toBe(0.5);
    });

    it("returns 0.7 for Minimax (exact match)", () => {
      expect(lookupModelTrustWeight("minimax")).toBe(0.7);
    });

    it("returns 0.8 for GLM-4 prefix match", () => {
      expect(lookupModelTrustWeight("glm-4")).toBe(0.8);
    });

    it("returns 0.5 for GLM-4-Flash (exact match)", () => {
      expect(lookupModelTrustWeight("glm-4-flash")).toBe(0.5);
    });

    it("returns 0.4 for Ollama (exact match)", () => {
      expect(lookupModelTrustWeight("ollama")).toBe(0.4);
    });

    it("returns 0.5 for unknown model (neutral default)", () => {
      expect(lookupModelTrustWeight("unknown-model-x")).toBe(0.5);
    });

    it("returns 0.5 for null/empty model", () => {
      expect(lookupModelTrustWeight("")).toBe(0.5);
      expect(lookupModelTrustWeight(null as any)).toBe(0.5);
    });

    it("prefix match: gpt-4o-2026-05-13 returns 0.9 (matches gpt-4o)", () => {
      expect(lookupModelTrustWeight("gpt-4o-2026-05-13")).toBe(0.9);
    });

    it("prefix match: claude-opus-4-8 returns 1.0 (matches claude-opus)", () => {
      expect(lookupModelTrustWeight("claude-opus-4-8")).toBe(1.0);
    });

    it("prefix match: glm-4-6 returns 0.8 (matches glm-4)", () => {
      expect(lookupModelTrustWeight("glm-4-6")).toBe(0.8);
    });

    it("normalizes model names (lowercase, collapses non-alphanumeric)", () => {
      expect(lookupModelTrustWeight("Claude.Opus")).toBe(1.0);
      expect(lookupModelTrustWeight("CLAUDE_OPUS")).toBe(1.0);
      expect(lookupModelTrustWeight("claude--opus")).toBe(1.0);
    });

    it("strips provider prefix", () => {
      expect(lookupModelTrustWeight("openai/gpt-4o")).toBe(0.9);
      expect(lookupModelTrustWeight("anthropic/claude-opus")).toBe(1.0);
    });

    it("env override: DRAGNET_MODEL_TRUST_GPT_5=0.95", () => {
      process.env.DRAGNET_MODEL_TRUST_GPT_5 = "0.95";
      expect(lookupModelTrustWeight("gpt-5")).toBe(0.95);
    });

    it("env override: DRAGNET_MODEL_TRUST_CLAUDE_OPUS=0.85", () => {
      process.env.DRAGNET_MODEL_TRUST_CLAUDE_OPUS = "0.85";
      expect(lookupModelTrustWeight("claude-opus")).toBe(0.85);
    });

    it("env override with provider prefix: openai/gpt-5", () => {
      process.env.DRAGNET_MODEL_TRUST_GPT_5 = "0.99";
      expect(lookupModelTrustWeight("openai/gpt-5")).toBe(0.99);
    });

    it("invalid env override falls back to table", () => {
      process.env.DRAGNET_MODEL_TRUST_GPT_4O = "invalid";
      expect(lookupModelTrustWeight("gpt-4o")).toBe(0.9);
    });

    it("env override out of range logs warning and falls back", () => {
      process.env.DRAGNET_MODEL_TRUST_GPT_4O = "2.0"; // > 1.0
      // Should log warning and fall back to table value
      expect(lookupModelTrustWeight("gpt-4o")).toBe(0.9);
    });

    it("longest prefix match wins", () => {
      // If both "gpt-4" and "gpt-4o" were in table, "gpt-4o" should win for "gpt-4o-mini"
      // Current table has "gpt-4o" and "gpt-4o-mini", so "gpt-4o-mini" matches exactly
      expect(lookupModelTrustWeight("gpt-4o-mini")).toBe(0.5);
    });
  });

  describe("TRUST_WEIGHTS table", () => {
    it("has valid weights (0.0 to 1.0)", () => {
      for (const [model, weight] of Object.entries(TRUST_WEIGHTS)) {
        expect(weight).toBeGreaterThanOrEqual(0.0);
        expect(weight).toBeLessThanOrEqual(1.0);
      }
    });

    it("includes Claude Opus with 1.0", () => {
      expect(TRUST_WEIGHTS["claude-opus"]).toBe(1.0);
    });

    it("includes Claude Sonnet with 0.9", () => {
      expect(TRUST_WEIGHTS["claude-sonnet"]).toBe(0.9);
    });

    it("includes Claude Haiku with 0.7", () => {
      expect(TRUST_WEIGHTS["claude-haiku"]).toBe(0.7);
    });

    it("includes GPT-4o with 0.9", () => {
      expect(TRUST_WEIGHTS["gpt-4o"]).toBe(0.9);
    });

    it("includes GPT-4o-mini with 0.5", () => {
      expect(TRUST_WEIGHTS["gpt-4o-mini"]).toBe(0.5);
    });

    it("includes Minimax with 0.7", () => {
      expect(TRUST_WEIGHTS["minimax"]).toBe(0.7);
    });

    it("includes GLM-4 with 0.8", () => {
      expect(TRUST_WEIGHTS["glm-4"]).toBe(0.8);
    });

    it("includes GLM-4-Flash with 0.5", () => {
      expect(TRUST_WEIGHTS["glm-4-flash"]).toBe(0.5);
    });

    it("includes Ollama with 0.4", () => {
      expect(TRUST_WEIGHTS["ollama"]).toBe(0.4);
    });
  });
});
