import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDecryptSecret: vi.fn(),
  mockHasMasterKey: vi.fn(),
  mockGetPublicUrl: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.mockFindUnique,
      update: mocks.mockUpdate,
    },
  },
}));

vi.mock("../src/lib/crypto", () => ({
  decryptSecret: mocks.mockDecryptSecret,
  hasMasterKey: mocks.mockHasMasterKey,
}));

vi.mock("../src/lib/publicUrl", () => ({
  getPublicUrl: mocks.mockGetPublicUrl,
}));

import { setupWebhookWithPat, deleteWebhook } from "../src/lib/webhookSetup";

describe("webhookSetup processing flag", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mocks.mockFetch as unknown as typeof fetch;
    mocks.mockHasMasterKey.mockReturnValue(true);
    mocks.mockDecryptSecret.mockReturnValue("pat-token");
    mocks.mockGetPublicUrl.mockReturnValue({ url: "https://dragnet.example" });
    mocks.mockUpdate.mockResolvedValue({});
    mocks.mockFindUnique.mockResolvedValue({
      id: "repo-1",
      cloneUrl: "https://github.com/o/r.git",
      cloneUrlHttps: "https://github.com/o/r.git",
      provider: "github",
      webhookSecret: "sec",
      webhookId: "hook-9",
      patCipher: "c",
      patIv: "i",
      patTag: "t",
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("setup enables webhook processing", async () => {
    mocks.mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42 }),
    });
    const result = await setupWebhookWithPat("repo-1");
    expect(result.webhookId).toBe("42");
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: expect.objectContaining({ webhookId: "42", webhookEnabled: true }),
    });
  });

  it("delete clears id and disables processing", async () => {
    mocks.mockFetch.mockResolvedValue({ ok: true });
    await deleteWebhook("repo-1");
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { webhookId: null, webhookEnabled: false },
    });
  });
});
