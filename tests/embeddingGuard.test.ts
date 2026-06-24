import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the llmClient so we can inject fake providers returning arbitrary
// vector shapes. The mock must be set before importing EmbeddingService.
vi.mock("../src/lib/llmClient", () => ({
  getChatClient: () => null,
  getChatModel: () => null,
  getEmbeddingChain: () => [],
}));

// Re-import per test so module-level state (circuit breaker) resets.
async function loadFresh() {
  vi.resetModules();
  return (await import("../src/services/embeddingService")).EmbeddingService;
}

// Per-test chain override. The mock above returns [] — these tests
// reach in and swap it via re-mocking.
async function withChain(chain: any[]) {
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => chain,
  }));
  return loadFresh();
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock("../src/lib/llmClient", () => ({
    getChatClient: () => null,
    getChatModel: () => null,
    getEmbeddingChain: () => [],
  }));
});

function fakeProvider(vec: number[], name = "fake"): any {
  return {
    name,
    model: "fake-model",
    client: {
      embeddings: {
        create: async () => ({ data: [{ embedding: vec }] }),
      },
    },
  };
}

describe("embedding dimension guard", () => {
  it("passes a 1536-dim vector through unchanged", async () => {
    const EmbeddingService = await withChain([fakeProvider(new Array(1536).fill(0.1))]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result.length).toBe(1536);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it("returns [] when provider returns wrong dim (e.g. 1024)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const EmbeddingService = await withChain([fakeProvider(new Array(1024).fill(0.2))]);
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("1024 dimensions"),
    );
    warn.mockRestore();
  });

  it("does NOT trip the circuit breaker on a dim mismatch (config issue, not outage)", async () => {
    const EmbeddingService = await withChain([fakeProvider(new Array(768).fill(0.3))]);
    await EmbeddingService.generateEmbedding("hello");
    expect(EmbeddingService.isCircuitOpen()).toBe(false);
  });

  it("still trips the breaker when the provider actually throws", async () => {
    const errProvider = {
      name: "broken",
      model: "x",
      client: { embeddings: { create: async () => { throw new Error("network down"); } } },
    };
    const EmbeddingService = await withChain([errProvider]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await EmbeddingService.generateEmbedding("hello");
    expect(result).toEqual([]);
    expect(EmbeddingService.isCircuitOpen()).toBe(true);
    err.mockRestore();
  });

  it("returns [] on empty input", async () => {
    const EmbeddingService = await loadFresh();
    expect(await EmbeddingService.generateEmbedding("")).toEqual([]);
  });
});
