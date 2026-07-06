import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  encryptSecret: vi.fn(),
  hasMasterKey: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    lLMPreset: {
      findMany: mocks.findMany,
      create: mocks.create,
      count: mocks.count,
    },
  },
}));

vi.mock("../src/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: vi.fn(),
  hasMasterKey: mocks.hasMasterKey,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.encryptSecret.mockReturnValue({ cipher: "enc", iv: "iv", tag: "tag" });
  mocks.hasMasterKey.mockReturnValue(true);
});

describe("seedFromLegacyFile", () => {
  it("returns 0 when table is not empty", async () => {
    mocks.count.mockResolvedValue(3);
    const { seedFromLegacyFile } = await import("../src/lib/llmPresets/seed");
    const result = await seedFromLegacyFile();
    expect(result).toBe(0);
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });

  it("returns 0 when file does not exist", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.existsSync.mockReturnValue(false);
    const { seedFromLegacyFile } = await import("../src/lib/llmPresets/seed");
    const result = await seedFromLegacyFile();
    expect(result).toBe(0);
  });

  it("returns 0 when file is unreadable", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    const { seedFromLegacyFile } = await import("../src/lib/llmPresets/seed");
    const result = await seedFromLegacyFile();
    expect(result).toBe(0);
  });

  it("imports presets from legacy file with encryption", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      presets: [
        { id: "p1", name: "OpenRouter", endpoint: "https://openrouter.ai/v1", apiKey: "sk-or", chatModel: "claude", embeddingModel: "" },
        { id: "p2", name: "Ollama", endpoint: "http://localhost:11434/v1", apiKey: "", chatModel: "", embeddingModel: "mxbai-embed-large" },
      ],
      primaryChatPresetId: "p1",
      primaryEmbeddingPresetId: "p2",
    }));
    mocks.create.mockResolvedValue({});

    const { seedFromLegacyFile } = await import("../src/lib/llmPresets/seed");
    const result = await seedFromLegacyFile();

    expect(result).toBe(2);
    expect(mocks.create).toHaveBeenCalledTimes(2);

    // First preset should have encrypted apiKey and be chat primary
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "p1",
          apiKeyCipher: "enc",
          apiKeyIv: "iv",
          apiKeyTag: "tag",
          isChatPrimary: true,
          isEmbeddingPrimary: false,
        }),
      }),
    );

    // Second preset should be embedding primary
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "p2",
          isChatPrimary: false,
          isEmbeddingPrimary: true,
        }),
      }),
    );
  });
});
