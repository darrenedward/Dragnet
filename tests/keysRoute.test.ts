import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFindMany: vi.fn(),
  mockRequireSession: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    apiKey: {
      create: mocks.mockCreate,
      findMany: mocks.mockFindMany,
    },
  },
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

import { GET, POST } from "../src/app/api/keys/route";

describe("POST /api/keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("requires session", async () => {
    mocks.mockRequireSession.mockRejectedValue(new Error("Unauthorized"));
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("requires a name", async () => {
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Name is required");
  });

  it("creates a global key when no repoId provided", async () => {
    mocks.mockCreate.mockResolvedValue({ id: "key-1" });
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CI Key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.key).toMatch(/^dr_/);
    expect(data.prefix).toBeTruthy();
    expect(data.name).toBe("CI Key");
    // Verify repoId was not passed to prisma
    const callArgs = mocks.mockCreate.mock.calls[0][0];
    expect(callArgs.data.repoId).toBeUndefined();
  });

  it("creates a repo-scoped key when repoId is provided", async () => {
    mocks.mockCreate.mockResolvedValue({ id: "key-1" });
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Repo Key", repoId: "repo-abc" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.key).toMatch(/^dr_/);
    // Verify repoId was passed to prisma
    const callArgs = mocks.mockCreate.mock.calls[0][0];
    expect(callArgs.data.repoId).toBe("repo-abc");
  });

  it("sets userId from the session", async () => {
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-7" } });
    mocks.mockCreate.mockResolvedValue({ id: "key-1" });
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "User Key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const callArgs = mocks.mockCreate.mock.calls[0][0];
    expect(callArgs.data.userId).toBe("user-7");
  });

  it("rejects with 401 when session has no user", async () => {
    mocks.mockRequireSession.mockResolvedValue({});
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Orphan Key" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("Session has no associated user");
  });
});

describe("GET /api/keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("requires session", async () => {
    mocks.mockRequireSession.mockRejectedValue(new Error("Unauthorized"));
    const req = new Request("http://localhost/api/keys");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns userId and user info per key", async () => {
    mocks.mockFindMany.mockResolvedValue([
      {
        id: "key-1",
        name: "Alice's Key",
        prefix: "dr_a1b2c…",
        repoId: null,
        userId: "user-1",
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
        createdAt: new Date("2026-01-01"),
        lastUsedAt: null,
        revoked: false,
      },
      {
        id: "key-2",
        name: "Legacy Key",
        prefix: "dr_d3e4f…",
        repoId: "repo-abc",
        userId: null,
        user: null,
        createdAt: new Date("2025-12-01"),
        lastUsedAt: new Date("2026-01-02"),
        revoked: false,
      },
    ]);
    const req = new Request("http://localhost/api/keys");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      id: "key-1",
      userId: "user-1",
      user: { id: "user-1", name: "Alice", email: "alice@example.com" },
    });
    expect(data[1]).toMatchObject({
      id: "key-2",
      userId: null,
      user: null,
    });
  });
});
