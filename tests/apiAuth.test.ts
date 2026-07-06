import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockRequireSession: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: mocks.mockFindUnique,
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

async function getMod() {
  return import("../src/lib/apiAuth");
}

describe("generateApiKey", () => {
  it("returns raw, prefix, and hash", async () => {
    const mod = await getMod();
    const result = mod.generateApiKey();
    expect(result.raw).toMatch(/^dr_/);
    expect(result.prefix).toMatch(/^dr_[a-f0-9]{5}\.\.\.$/);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hash of raw matches stored hash", async () => {
    const mod = await getMod();
    const { raw, hash } = mod.generateApiKey();
    const crypto = await import("crypto");
    const expected = crypto.createHash("sha256").update(raw).digest("hex");
    expect(hash).toBe(expected);
  });
});

describe("authenticateApiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing authorization header", async () => {
    const mod = await getMod();
    const req = new Request("http://localhost/api/test");
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing or invalid Authorization");
  });

  it("rejects non-Bearer authorization header", async () => {
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing or invalid Authorization");
  });

  it("rejects invalid key format (not dr_ prefix)", async () => {
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer invalid-key-format" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid API key format");
  });

  it("rejects revoked key", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: null,
      userId: null,
      revoked: true,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("revoked");
  });

  it("returns repoId for repo-scoped keys", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: "repo-abc",
      userId: null,
      revoked: false,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(true);
    expect(result.repoId).toBe("repo-abc");
  });

  it("returns null repoId for global keys", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: null,
      userId: null,
      revoked: false,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(true);
    expect(result.repoId).toBeNull();
  });

  it("returns userId when key is owned by a user", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: null,
      userId: "user-42",
      revoked: false,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(true);
    expect(result.userId).toBe("user-42");
  });

  it("returns null userId for legacy keys (no owner)", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: "repo-abc",
      userId: null,
      revoked: false,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(true);
    expect(result.userId).toBeNull();
  });

  it("key not found in DB", async () => {
    mocks.mockFindUnique.mockResolvedValue(null);
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateApiRequest(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("enforceRepoScope", () => {
  it("allows global key (repoId null) to access any repo", async () => {
    const mod = await getMod();
    const result = mod.enforceRepoScope({ ok: true, repoId: null, userId: null }, "repo-abc");
    expect(result).toBeNull();
  });

  it("allows repo-scoped key to access its own repo", async () => {
    const mod = await getMod();
    const result = mod.enforceRepoScope({ ok: true, repoId: "repo-abc", userId: null }, "repo-abc");
    expect(result).toBeNull();
  });

  it("rejects repo-scoped key accessing a different repo", async () => {
    const mod = await getMod();
    const result = mod.enforceRepoScope({ ok: true, repoId: "repo-abc", userId: null }, "repo-xyz");
    expect(result).toBeInstanceOf(Object);
    expect((result as any).error).toContain("does not have access");
  });

  it("rejects when auth failed", async () => {
    const mod = await getMod();
    const result = mod.enforceRepoScope({ ok: false, error: "Unauthorized", repoId: null, userId: null }, "repo-abc");
    expect(result).toBeInstanceOf(Object);
    expect((result as any).error).toContain("Unauthorized");
  });
});

describe("authenticateSessionOrKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns userId from session when no Bearer header", async () => {
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-99", email: "alice@example.com" } });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test");
    const result = await mod.authenticateSessionOrKey(req);
    expect(result.ok).toBe(true);
    expect(result.userId).toBe("user-99");
    expect(result.repoId).toBeNull();
  });

  it("falls back to API key auth when Bearer header is present", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "key-1",
      repoId: null,
      userId: "user-77",
      revoked: false,
      lastUsedAt: null,
    });
    const mod = await getMod();
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer dr_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" },
    });
    const result = await mod.authenticateSessionOrKey(req);
    expect(result.ok).toBe(true);
    expect(result.userId).toBe("user-77");
  });

  it("returns error with null userId when both auth methods fail", async () => {
    mocks.mockRequireSession.mockRejectedValue(new Error("Unauthorized"));
    const mod = await getMod();
    const req = new Request("http://localhost/api/test");
    const result = await mod.authenticateSessionOrKey(req);
    expect(result.ok).toBe(false);
    expect(result.userId).toBeNull();
  });
});
