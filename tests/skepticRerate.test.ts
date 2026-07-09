import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CandidateFinding } from "../src/services/findingVerifier/types";

/**
 * Skeptic re-rate tests (issue #72).
 *
 * `rerateWithSurvivors` re-prompts the primary chat model for a fresh
 * holistic rating after the skeptic pass rejects some findings. The
 * original score no longer reflects what the user sees; the bump formula
 * was uncalibrated noise, so the literal spec reading is "re-ask the
 * LLM on the survivor set."
 *
 * Mock posture: vi.mock llmClient.getChatChain to return controlled
 * ChainEntry[] with fake client.chat.completions.create fns. The module
 * under test lives at src/services/findingVerifier/skepticRerate.ts.
 */

const { getChatChainMock } = vi.hoisted(() => ({
  getChatChainMock: vi.fn(),
}));

vi.mock("../src/lib/llmClient", () => ({
  getChatChain: getChatChainMock,
}));

// Import after mock registration.
import { rerateWithSurvivors } from "../src/services/findingVerifier/skepticRerate";
import type { ChainEntry } from "../src/lib/llmClient";

beforeEach(() => {
  getChatChainMock.mockReset();
});

function survivor(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Security",
    severity: "blocker",
    filename: "src/app.ts",
    line: 10,
    explanation: "bug",
    ...opts,
  };
}

/**
 * Build a fake ChainEntry with a controllable create() fn. The `client`
 * shape is the minimum OpenAI-SDK surface area the module touches.
 */
function fakeEntry(
  name: string,
  model: string,
  createImpl: (params: any) => Promise<any> | any,
  endpoint = "https://api.openai.com/v1",
): ChainEntry {
  return {
    name,
    model,
    endpoint,
    client: {
      chat: {
        completions: {
          create: vi.fn(createImpl),
        },
      },
    } as any,
    // Unused by this module, but type-required:
  } as unknown as ChainEntry;
}

function jsonResponse(rating: number, summary: string): any {
  return {
    choices: [{ message: { content: JSON.stringify({ rating, summary }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

describe("rerateWithSurvivors — happy path", () => {
  it("returns the rating from the primary provider when it succeeds", async () => {
    const entry = fakeEntry("Primary", "gpt-4o", async () =>
      jsonResponse(8, "Survivors look clean."),
    );
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 6,
      originalSummary: "old summary",
      repoPath: null,
    });

    expect(result.ok).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.summary).toBe("Survivors look clean.");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe("success");
    expect(result.attempts[0].provider).toBe("Primary");
    expect(result.attempts[0].rating).toBe(8);
  });

  it("captures token usage from the response", async () => {
    const entry = fakeEntry("Primary", "gpt-4o", async () => jsonResponse(7, "ok"));
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.attempts[0].promptTokens).toBe(100);
    expect(result.attempts[0].completionTokens).toBe(30);
    expect(result.attempts[0].costUsd).toBeGreaterThan(0);
  });

  it("strips <think> blocks before parsing", async () => {
    const entry = fakeEntry("Primary", "glm-4.6", async () => ({
      choices: [
        {
          message: {
            content:
              "<think>internal reasoning here</think>\n" +
              JSON.stringify({ rating: 9, summary: "Clean." }),
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }));
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 7,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(true);
    expect(result.rating).toBe(9);
  });
});

describe("rerateWithSurvivors — provider chain fallback", () => {
  it("tries fallback when primary throws", async () => {
    const primary = fakeEntry("Primary", "gpt-4o", async () => {
      throw new Error("network down");
    });
    const fallback = fakeEntry("Fallback", "claude-sonnet-4", async () =>
      jsonResponse(7, "Fallback graded."),
    );
    getChatChainMock.mockReturnValue([primary, fallback]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(true);
    expect(result.rating).toBe(7);
    expect(result.summary).toBe("Fallback graded.");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].provider).toBe("Primary");
    expect(result.attempts[0].outcome).toBe("transport_failure");
    expect(result.attempts[1].provider).toBe("Fallback");
    expect(result.attempts[1].outcome).toBe("success");
  });

  it("tries fallback when primary returns unparseable response", async () => {
    const primary = fakeEntry("Primary", "gpt-4o", async () => ({
      choices: [{ message: { content: "I can't do that." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const fallback = fakeEntry("Fallback", "claude-sonnet-4", async () =>
      jsonResponse(8, "OK."),
    );
    getChatChainMock.mockReturnValue([primary, fallback]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.attempts[0].outcome).toBe("quality_failure");
    expect(result.attempts[1].outcome).toBe("success");
  });

  it("returns ok=false when every provider throws", async () => {
    const primary = fakeEntry("Primary", "gpt-4o", async () => {
      throw new Error("primary down");
    });
    const fallback = fakeEntry("Fallback", "claude-sonnet-4", async () => {
      throw new Error("fallback down");
    });
    getChatChainMock.mockReturnValue([primary, fallback]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(false);
    expect(result.rating).toBe(null);
    expect(result.summary).toBe("");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every(a => a.outcome === "transport_failure")).toBe(true);
    expect(result.error).toMatch(/down/);
  });
});

describe("rerateWithSurvivors — early-exit conditions", () => {
  it("returns ok=false with no attempts when survivors list is empty", async () => {
    const result = await rerateWithSurvivors({
      survivors: [],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(false);
    expect(result.rating).toBe(null);
    expect(result.attempts).toEqual([]);
    expect(result.error).toBe("no survivors to re-rate");
    expect(getChatChainMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when no chat provider is configured", async () => {
    getChatChainMock.mockReturnValue([]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no chat provider configured");
    expect(result.attempts).toEqual([]);
  });
});

describe("rerateWithSurvivors — response parsing", () => {
  it("parses a JSON object wrapped in a markdown fence", async () => {
    const entry = fakeEntry("Primary", "gpt-4o", async () => ({
      choices: [
        {
          message: {
            content:
              "```json\n" + JSON.stringify({ rating: 7, summary: "Good." }) + "\n```",
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(true);
    expect(result.rating).toBe(7);
  });

  it("coerces string ratings to numbers and clamps to [1,10]", async () => {
    const entry = fakeEntry("Primary", "gpt-4o", async () => ({
      choices: [{ message: { content: JSON.stringify({ rating: "15", summary: "x" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.rating).toBe(10);
  });

  it("marks quality_failure when rating field is missing", async () => {
    const entry = fakeEntry("Primary", "gpt-4o", async () => ({
      choices: [{ message: { content: JSON.stringify({ foo: "bar" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    getChatChainMock.mockReturnValue([entry]);

    const result = await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts[0].outcome).toBe("quality_failure");
  });
});

describe("rerateWithSurvivors — prompt shape", () => {
  it("includes the survivor findings and rejected findings in the user prompt", async () => {
    let captured: any;
    const entry = fakeEntry("Primary", "gpt-4o", async (params: any) => {
      captured = params;
      return jsonResponse(8, "ok");
    });
    getChatChainMock.mockReturnValue([entry]);

    await rerateWithSurvivors({
      survivors: [
        survivor({ id: "1", severity: "warning", category: "Performance" }),
      ],
      rejected: [
        { id: "2", category: "Security", severity: "blocker", reason: "FP — no sink" },
      ],
      originalRating: 6,
      originalSummary: "old",
      repoPath: null,
    });

    const userContent: string = captured.messages?.[1]?.content ?? "";
    expect(userContent).toContain("Original rating: 6/10");
    expect(userContent).toContain("Rejected findings");
    expect(userContent).toContain("category=Security severity=blocker");
    expect(userContent).toContain("FP — no sink");
    expect(userContent).toContain("Surviving findings (1)");
    expect(userContent).toContain("severity=warning");
  });

  it("applies reasoning-model params for gpt-5", async () => {
    let captured: any;
    const entry = fakeEntry("Primary", "gpt-5.2", async (params: any) => {
      captured = params;
      return jsonResponse(9, "ok");
    });
    getChatChainMock.mockReturnValue([entry]);

    await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(captured.reasoning_effort).toBe("xhigh");
    expect(captured.max_completion_tokens).toBe(1024);
    expect(captured.max_tokens).toBeUndefined();
  });

  it("omits response_format when the endpoint is NVIDIA NIM", async () => {
    let captured: any;
    const entry = fakeEntry(
      "NVIDIA",
      "nemotron-3-super-120b-a12b",
      async (params: any) => {
        captured = params;
        return jsonResponse(8, "ok");
      },
      "https://integrate.api.nvidia.com/v1",
    );
    getChatChainMock.mockReturnValue([entry]);

    await rerateWithSurvivors({
      survivors: [survivor({ id: "1" })],
      rejected: [],
      originalRating: 5,
      originalSummary: "",
      repoPath: null,
    });

    expect(captured.response_format).toBeUndefined();
    // nemotron-3 gets reasoning_effort: low per the tuning map
    expect(captured.reasoning_effort).toBe("low");
  });
});
