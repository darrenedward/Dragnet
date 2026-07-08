import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockFindMany: vi.fn(),
  mockRequireSession: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    apiKey: {
      findUnique: mocks.mockFindUnique,
      create: mocks.mockCreate,
      findMany: mocks.mockFindMany,
      delete: mocks.mockDelete,
    },
    userRepo: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

async function getMod() {
  return import("../src/lib/apiAuth");
}

describe("verifyUserCanCreateRepoKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when UserRepo exists", async () => {
    const mod = await getMod();
    mocks.mockFindUnique.mockResolvedValue({ userId: "user-1", repoId: "repo-1" });
    const result = await mod.verifyUserCanCreateRepoKey("user-1", "repo-1");
    expect(result.ok).toBe(true);
  });

  it("returns error when UserRepo missing", async () => {
    const mod = await getMod();
    mocks.mockFindUnique.mockResolvedValue(null);
    const result = await mod.verifyUserCanCreateRepoKey("user-1", "repo-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not assigned");
  });
});

describe("GET /api/user/keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("returns keys filtered by repoId", async () => {
    mocks.mockFindUnique.mockResolvedValue({ userId: "user-1", repoId: "repo-1" });
    mocks.mockFindMany.mockResolvedValue([
      { id: "key-1", userId: "user-1", repoId: "repo-1", prefix: "dr_abc...", name: "Test", revoked: false, createdAt: new Date(), lastUsedAt: null },
    ]);
    const { GET } = await import("../src/app/api/user/keys/route");
    const req = new Request("http://localhost/api/user/keys?repoId=repo-1");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].repoId).toBe("repo-1");
  });
});

describe("DELETE /api/keys/[id] ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows API key owner to delete their key", async () => {
    mocks.mockFindUnique.mockResolvedValue({ id: "key-1", userId: "user-1", repoId: "repo-1", revoked: false });
    mocks.mockDelete.mockResolvedValue({});
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
    const { DELETE } = await import("../src/app/api/keys/[id]/route");
    const req = new Request("http://localhost/api/keys/key-1", {
      headers: { Authorization: "Bearer dr_test" },
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "key-1" }) });
    expect(res.status).toBe(200);
  });

  it("rejects API key owner deleting another user's key", async () => {
    mocks.mockFindUnique.mockResolvedValue({ id: "key-1", userId: "user-2", repoId: "repo-1", revoked: false });
    const { DELETE } = await import("../src/app/api/keys/[id]/route");
    const req = new Request("http://localhost/api/keys/key-1", {
      headers: { Authorization: "Bearer dr_test" },
    });
    // Mock authenticateApiRequest to return userId "user-1"
    vi.doMock("@/src/lib/apiAuth", () => ({
      authenticateSessionOrKey: vi.fn().mockResolvedValue({ ok: true, userId: "user-1", repoId: null }),
    }));
    const { DELETE: Del } = await import("../src/app/api/keys/[id]/route");
    const res = await Del(req, { params: Promise.resolve({ id: "key-1" }) });
    expect(res.status).toBe(403);
  });
});
