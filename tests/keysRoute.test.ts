import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockRequireSession: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    apiKey: {
      create: mocks.mockCreate,
    },
  },
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

import { POST } from "../src/app/api/keys/route";

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
});
