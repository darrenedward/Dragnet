import { describe, it, expect } from "vitest";
import { isSameChatModel } from "../src/lib/skepticSameModel";

/**
 * Same-model guard tests for the SkepticPanel (issue #72).
 *
 * The guard blocks the user from enabling the skeptic pass when the
 * fallback chat preset's endpoint + chatModel match the primary's.
 * Same-model self-review has the same blind spots as the primary pass
 * and produces no signal — better to disable the toggle than ship quiet
 * no-ops. See src/lib/skepticSameModel.ts for the comparison contract.
 */

describe("isSameChatModel", () => {
  it("returns false when either side is null/undefined", () => {
    expect(isSameChatModel(null, null)).toBe(false);
    expect(isSameChatModel(undefined, undefined)).toBe(false);
    expect(
      isSameChatModel({ endpoint: "https://x/v1", chatModel: "gpt-4o" }, null),
    ).toBe(false);
    expect(
      isSameChatModel(null, { endpoint: "https://x/v1", chatModel: "gpt-4o" }),
    ).toBe(false);
  });

  it("returns true on exact endpoint + model match", () => {
    expect(
      isSameChatModel(
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "anthropic/claude-sonnet-4" },
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "anthropic/claude-sonnet-4" },
      ),
    ).toBe(true);
  });

  it("returns false when models differ", () => {
    expect(
      isSameChatModel(
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "claude-sonnet-4" },
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(false);
  });

  it("returns false when endpoints differ", () => {
    expect(
      isSameChatModel(
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "gpt-4o" },
        { endpoint: "https://api.openai.com/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(false);
  });

  it("normalizes endpoint trailing slash", () => {
    expect(
      isSameChatModel(
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "gpt-4o" },
        { endpoint: "https://openrouter.ai/api/v1/", chatModel: "gpt-4o" },
      ),
    ).toBe(true);
  });

  it("normalizes endpoint case", () => {
    expect(
      isSameChatModel(
        { endpoint: "HTTPS://OpenRouter.ai/API/v1", chatModel: "gpt-4o" },
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(true);
  });

  it("normalizes model case (provider catalogs are inconsistent)", () => {
    expect(
      isSameChatModel(
        { endpoint: "https://api.openai.com/v1", chatModel: "GPT-4O" },
        { endpoint: "https://api.openai.com/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(true);
  });

  it("trims whitespace before comparing", () => {
    expect(
      isSameChatModel(
        { endpoint: "  https://openrouter.ai/api/v1  ", chatModel: "  gpt-4o " },
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(true);
  });

  it("returns false when either field is empty", () => {
    expect(
      isSameChatModel(
        { endpoint: "", chatModel: "gpt-4o" },
        { endpoint: "https://x/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(false);
    expect(
      isSameChatModel(
        { endpoint: "https://x/v1", chatModel: "" },
        { endpoint: "https://x/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(false);
    expect(
      isSameChatModel(
        { endpoint: "https://x/v1", chatModel: "   " },
        { endpoint: "https://x/v1", chatModel: "gpt-4o" },
      ),
    ).toBe(false);
  });

  it("treats duplicate preset (same endpoint+model) as same even when the user copied the preset", () => {
    // The issue calls out this case: a user can create a second preset
    // pointing at the same upstream. The id-based dedup in getChatChain
    // wouldn't catch it; the endpoint+model check does.
    expect(
      isSameChatModel(
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "anthropic/claude-sonnet-4" },
        { endpoint: "https://openrouter.ai/api/v1", chatModel: "anthropic/claude-sonnet-4" },
      ),
    ).toBe(true);
  });
});
