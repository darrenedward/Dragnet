import { describe, it, expect, beforeEach, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockCreateKey = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mockAuth,
  generateApiKey: () => ({
    raw: "dr_test_raw_key_123",
    prefix: "dr_test...",
    hash: "abc123hash",
  }),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: {
      findFirst: mockFindFirst,
    },
    apiKey: {
      create: mockCreateKey,
    },
  },
}));

async function lookup(remoteUrl: string | null): Promise<Response> {
  const { GET } = await import("@/src/app/api/repos/lookup/route");
  const url = remoteUrl
    ? `http://localhost/api/repos/lookup?remoteUrl=${encodeURIComponent(remoteUrl)}`
    : "http://localhost/api/repos/lookup";
  const req = new Request(url);
  return GET(req);
}

describe("GET /api/repos/lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ ok: true });
    mockFindFirst.mockResolvedValue(null);
    mockCreateKey.mockResolvedValue({ id: "key-1" });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue({ ok: false, error: "Unauthorized" });
    const res = await lookup("git@github.com:owner/repo.git");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 when remoteUrl is missing", async () => {
    const res = await lookup(null);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("remoteUrl");
  });

  it("returns 400 when remoteUrl is unparseable", async () => {
    const res = await lookup("not-a-url");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Cannot parse git remote URL");
  });

  it("returns exists:false when repo not found", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await lookup("git@github.com:unknown/project.git");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.repoId).toBe("github.com/unknown/project");
  });

  it("returns repoId and scoped API key when repo found by repoId", async () => {
    mockFindFirst.mockResolvedValue({ id: "repo-1", name: "test-repo" });
    mockCreateKey.mockResolvedValue({ id: "key-1" });

    const res = await lookup("git@github.com:owner/existing-repo.git");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.repoId).toBe("repo-1");
    expect(body.repoIdNormalized).toBe("github.com/owner/existing-repo");
    expect(body.apiKey).toBe("dr_test_raw_key_123");
    expect(body.apiBase).toBe("http://localhost");
  });

  it("searches by repoId column", async () => {
    mockFindFirst.mockResolvedValue({ id: "repo-2", name: "another-repo" });
    mockCreateKey.mockResolvedValue({ id: "key-2" });

    const res = await lookup("https://github.com/owner/another-repo.git");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.repoId).toBe("repo-2");
    expect(body.repoIdNormalized).toBe("github.com/owner/another-repo");
    expect(body.apiKey).toBe("dr_test_raw_key_123");

    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { repoId: "github.com/owner/another-repo" },
      select: { id: true, name: true },
    });
  });

  it("returns normalized repoId even when repo not found", async () => {
    const res = await lookup("https://gitlab.com/team/new-project.git");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.repoId).toBe("gitlab.com/team/new-project");
  });

  it("creates an ApiKey record scoped to the repo", async () => {
    mockFindFirst.mockResolvedValue({ id: "repo-1", name: "test-repo" });
    mockCreateKey.mockResolvedValue({ id: "key-1" });

    await lookup("git@github.com:owner/existing-repo.git");

    expect(mockCreateKey).toHaveBeenCalledWith({
      data: {
        name: "dragnet-init:test-repo",
        prefix: "dr_test...",
        hash: "abc123hash",
        repoId: "repo-1",
      },
    });
  });
});
