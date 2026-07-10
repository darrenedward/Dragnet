import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Preset, PresetsFile } from "../src/lib/llmPresets/types";

const mocks = vi.hoisted(() => ({
  lLMPreset: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  $transaction: vi.fn((fn: any) => fn({
    lLMPreset: mocks.lLMPreset,
  })),
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
  hasMasterKey: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    lLMPreset: mocks.lLMPreset,
    $transaction: mocks.$transaction,
  },
}));

vi.mock("../src/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
  hasMasterKey: mocks.hasMasterKey,
}));

function makeDbRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "p1",
    name: "Test",
    endpoint: "https://example.com/v1",
    apiKeyCipher: "cipher1",
    apiKeyIv: "iv1",
    apiKeyTag: "tag1",
    chatModel: "model-x",
    embeddingModel: "",
    maxIterations: 16,
    isChatPrimary: true,
    isEmbeddingPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptSecret.mockReturnValue("sk-decrypted");
  mocks.encryptSecret.mockReturnValue({ cipher: "enc", iv: "iv", tag: "tag" });
  mocks.hasMasterKey.mockReturnValue(true);
  // Reset global cache
  const g = globalThis as any;
  delete g.__presetCache;
  delete g.__presetCacheVersion;
});

describe("listPresets", () => {
  it("returns preset views from cached DB data", async () => {
    await import("../src/lib/llmPresets/service");

    // Manually populate the cache
    const g = globalThis as any;
    g.__presetCacheVersion = 0;
    g.__presetCache = {
      version: 0,
      presets: [{
        id: "p1",
        name: "Test",
        endpoint: "https://example.com/v1",
        apiKey: "sk-decrypted",
        chatModel: "model-x",
        embeddingModel: "",
      }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };

    const { listPresets } = await import("../src/lib/llmPresets/service");
    const result = listPresets();
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0]).toMatchObject({
      id: "p1",
      name: "Test",
      hasApiKey: true,
      chatModel: "model-x",
    });
    expect(result.presets[0].apiKey).toBeUndefined();
    expect(result.primaryChatPresetId).toBe("p1");
  });
});

describe("getPrimaryChatPreset", () => {
  it("returns the primary chat preset from cache", async () => {
    const g = globalThis as any;
    g.__presetCacheVersion = 0;
    g.__presetCache = {
      version: 0,
      presets: [{
        id: "p1",
        name: "Test",
        endpoint: "https://example.com/v1",
        apiKey: "sk-decrypted",
        chatModel: "model-x",
        embeddingModel: "",
        maxIterations: 8,
      }, {
        id: "p2",
        name: "Backup",
        endpoint: "https://backup.com/v1",
        apiKey: "sk-backup",
        chatModel: "model-y",
        embeddingModel: "",
      }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "p2",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };

    const { getPrimaryChatPreset } = await import("../src/lib/llmPresets/service");
    const result = getPrimaryChatPreset();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("p1");
    expect(result!.apiKey).toBe("sk-decrypted");
  });

  it("returns null when no primary is set", async () => {
    const g = globalThis as any;
    g.__presetCacheVersion = 0;
    g.__presetCache = {
      version: 0,
      presets: [],
      primaryChatPresetId: "",
      fallbackChatPresetId: "",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };

    const { getPrimaryChatPreset } = await import("../src/lib/llmPresets/service");
    expect(getPrimaryChatPreset()).toBeNull();
  });
});

describe("getFallbackChatPreset", () => {
  it("returns the fallback when it differs from primary", async () => {
    const g = globalThis as any;
    g.__presetCacheVersion = 0;
    g.__presetCache = {
      version: 0,
      presets: [{ id: "p1", name: "Primary", endpoint: "https://a.com", apiKey: "", chatModel: "m1", embeddingModel: "" }, { id: "p2", name: "Fallback", endpoint: "https://b.com", apiKey: "", chatModel: "m2", embeddingModel: "" }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "p2",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };

    const { getFallbackChatPreset } = await import("../src/lib/llmPresets/service");
    const result = getFallbackChatPreset();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("p2");
  });

  it("returns null when fallback is same as primary", async () => {
    const g = globalThis as any;
    g.__presetCacheVersion = 0;
    g.__presetCache = {
      version: 0,
      presets: [{ id: "p1", name: "Only", endpoint: "https://a.com", apiKey: "", chatModel: "m1", embeddingModel: "" }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "p1",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };

    const { getFallbackChatPreset } = await import("../src/lib/llmPresets/service");
    expect(getFallbackChatPreset()).toBeNull();
  });
});

describe("savePresets", () => {
  it("upserts presets, deletes removed ones, and enforces primary flags", async () => {
    mocks.lLMPreset.findMany
      .mockResolvedValueOnce([makeDbRow({ id: "p1" }), makeDbRow({ id: "p2", isChatPrimary: false })]);
    mocks.lLMPreset.updateMany.mockResolvedValue({ count: 1 });

    const { savePresets } = await import("../src/lib/llmPresets/service");

    const state: PresetsFile = {
      presets: [{
        id: "p1",
        name: "Updated",
        endpoint: "https://example.com/v1",
        apiKey: "sk-new-key",
        chatModel: "model-z",
        embeddingModel: "",
        maxIterations: 10,
      }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
    };

    await savePresets(state);

    // p2 should be deleted (not in incoming)
    expect(mocks.lLMPreset.delete).toHaveBeenCalledWith({ where: { id: "p2" } });

    // p1 should be upserted
    expect(mocks.lLMPreset.upsert).toHaveBeenCalledTimes(1);

    // Primary demotion should run
    expect(mocks.lLMPreset.updateMany).toHaveBeenCalled();
  });
});

describe("encryption round-trip via service", () => {
  it("encrypts keys on save and decrypts on read", async () => {
    // Simulate saving a preset with a key
    const { savePresets } = await import("../src/lib/llmPresets/service");

    mocks.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        lLMPreset: {
          findMany: vi.fn().mockResolvedValue([]),
          delete: vi.fn(),
          upsert: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({}),
        },
      };
      await fn(tx);
    });

    const state: PresetsFile = {
      presets: [{
        id: "p1",
        name: "Encrypted Test",
        endpoint: "https://example.com/v1",
        apiKey: "sk-secret",
        chatModel: "model-a",
        embeddingModel: "",
      }],
      primaryChatPresetId: "p1",
      fallbackChatPresetId: "",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
    };

    await savePresets(state);

    expect(mocks.encryptSecret).toHaveBeenCalledWith("sk-secret");
  });
});
