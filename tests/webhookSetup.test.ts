import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockDecryptSecret: vi.fn(() => "test-pat"),
  mockHasMasterKey: vi.fn(() => true),
  mockGetPublicUrl: vi.fn(() => ({ url: "https://dragnet.example.com" })),
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

const baseRepo = {
  id: "repo-1",
  cloneUrl: "https://github.com/owner/repo.git",
  cloneUrlHttps: "https://github.com/owner/repo.git",
  provider: "github",
  patCipher: "c",
  patIv: "i",
  patTag: "t",
  webhookSecret: "existing-secret",
  webhookId: null as string | null,
};

describe("setupWebhookWithPat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.mockFetch);
    mocks.mockFindUnique.mockResolvedValue({ ...baseRepo });
    mocks.mockUpdate.mockResolvedValue({});
    mocks.mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 98765 }),
      text: async () => "",
    });
  });

  it("sets webhookEnabled true on successful GitHub webhook create", async () => {
    const result = await setupWebhookWithPat("repo-1");
    expect(result.webhookId).toBe("98765");
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: expect.objectContaining({
        webhookId: "98765",
        webhookEnabled: true,
      }),
    });
  });

  it("sets webhookEnabled true on successful GitLab webhook create", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      ...baseRepo,
      provider: "gitlab",
      cloneUrl: "https://gitlab.com/owner/repo.git",
      cloneUrlHttps: "https://gitlab.com/owner/repo.git",
    });
    mocks.mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 111 }),
      text: async () => "",
    });

    const result = await setupWebhookWithPat("repo-1");
    expect(result.webhookId).toBe("111");
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: expect.objectContaining({
        webhookId: "111",
        webhookEnabled: true,
      }),
    });
  });
});

describe("deleteWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.mockFetch);
    mocks.mockUpdate.mockResolvedValue({});
    mocks.mockFetch.mockResolvedValue({ ok: true, status: 204, text: async () => "" });
  });

  it("clears webhookId and disables processing after provider delete", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      ...baseRepo,
      webhookId: "hook-42",
    });

    await deleteWebhook("repo-1");

    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { webhookId: null, webhookEnabled: false },
    });
  });

  it("clears webhookId and disables processing when no PAT is stored", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      ...baseRepo,
      webhookId: "hook-42",
      patCipher: null,
      patIv: null,
      patTag: null,
    });

    await deleteWebhook("repo-1");

    expect(mocks.mockFetch).not.toHaveBeenCalled();
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { webhookId: null, webhookEnabled: false },
    });
  });

  it("no-ops when webhook is not configured", async () => {
    mocks.mockFindUnique.mockResolvedValue({ ...baseRepo, webhookId: null });
    await deleteWebhook("repo-1");
    expect(mocks.mockUpdate).not.toHaveBeenCalled();
  });
});
