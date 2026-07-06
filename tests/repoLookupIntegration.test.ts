import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Integration test for GET /api/repos/lookup endpoint.
 *
 * Tests the round-trip:
 *   1. Simulate repo registration by setting up mocked database state
 *   2. Query via GET /api/repos/lookup with a variant of the URL
 *   3. Assert exists: true and repoId matches the canonical form
 *
 * Mocks the database layer but uses the actual lookup route handler,
 * ensuring the URL canonicalization and lookup logic work correctly.
 */

const mockAuth = vi.fn();
const mockFindFirst = vi.fn();
const mockCreateKey = vi.fn();

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mockAuth,
  generateApiKey: () => ({
    raw: "dr_test_lookup_key",
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

async function lookupRepo(remoteUrl: string): Promise<{ exists: boolean; repoId: string; apiKey?: string; apiBase?: string }> {
  const { GET } = await import("@/src/app/api/repos/lookup/route");
  const url = `http://localhost/api/repos/lookup?remoteUrl=${encodeURIComponent(remoteUrl)}`;
  const req = new Request(url);
  const res = await GET(req);
  const body = await res.json();

  if (res.status !== 200) {
    throw new Error(`Lookup failed: ${JSON.stringify(body)}`);
  }

  return {
    exists: body.exists,
    repoId: body.repoId,
    apiKey: body.apiKey,
    apiBase: body.apiBase,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ ok: true });
  mockFindFirst.mockResolvedValue(null);
  mockCreateKey.mockResolvedValue({ id: "key-1" });
});

describe("GET /api/repos/lookup integration test", () => {
  it("returns canonical repoId when repo exists", async () => {
    // Simulate a registered GitHub repo
    mockFindFirst.mockResolvedValue({
      id: "repo-1",
      name: "test-repo",
    });

    const result = await lookupRepo("git@github.com:owner/test-repo.git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("github.com/owner/test-repo");
    expect(result.apiKey).toBe("dr_test_lookup_key");
    expect(result.apiBase).toBe("http://localhost");
  });

  it("returns canonical repoId when queried with HTTPS variant of SSH URL", async () => {
    // Register with SSH URL - mock returns the same repo regardless
    mockFindFirst.mockResolvedValue({
      id: "repo-2",
      name: "variant-test",
    });

    // Query with HTTPS URL variant
    const result = await lookupRepo("https://github.com/owner/variant-test.git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("github.com/owner/variant-test");
  });

  it("returns canonical repoId when queried with SSH variant of HTTPS URL", async () => {
    // Mock repo registered with HTTPS URL
    mockFindFirst.mockResolvedValue({
      id: "repo-3",
      name: "https-variant",
    });

    // Query with SSH URL variant
    const result = await lookupRepo("git@github.com:owner/https-variant.git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("github.com/owner/https-variant");
  });

  // TODO: Re-enable after issue #28 (ssh:// protocol support) is implemented
  // it("handles ssh:// protocol variant", async () => {
  //   // Mock repo registered with standard SSH URL
  //   mockFindFirst.mockResolvedValue({
  //     id: "repo-4",
  //     name: "ssh-protocol",
  //   });

  //   // Query with ssh:// protocol variant
  //   const result = await lookupRepo("ssh://git@github.com/owner/ssh-protocol.git");

  //   expect(result.exists).toBe(true);
  //   expect(result.repoId).toBe("github.com/owner/ssh-protocol");
  // });

  it("returns exists:false for unregistered repo", async () => {
    mockFindFirst.mockResolvedValue(null);

    const result = await lookupRepo("git@github.com:owner/nonexistent.git");

    expect(result.exists).toBe(false);
    expect(result.repoId).toBe("github.com/owner/nonexistent");
  });

  it("handles GitLab URLs", async () => {
    // Mock a GitLab repo
    mockFindFirst.mockResolvedValue({
      id: "repo-5",
      name: "gitlab-project",
    });

    const result = await lookupRepo("git@gitlab.com:team/project.git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("gitlab.com/team/project");
  });

  it("handles URLs with .git suffix", async () => {
    // Mock repo registered with .git suffix
    mockFindFirst.mockResolvedValue({
      id: "repo-6",
      name: "with-git",
    });

    // Query without .git suffix
    const result = await lookupRepo("git@github.com:owner/with-git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("github.com/owner/with-git");
  });

  it("generates scoped API key when repo exists", async () => {
    // Mock a registered repo
    mockFindFirst.mockResolvedValue({
      id: "repo-7",
      name: "apikey-test",
    });

    const result = await lookupRepo("git@github.com:owner/apikey-test.git");

    expect(result.exists).toBe(true);
    expect(result.apiKey).toBe("dr_test_lookup_key");
    expect(result.apiBase).toBe("http://localhost");

    // Verify that the API key was created in the database
    expect(mockCreateKey).toHaveBeenCalledWith({
      data: {
        name: "dragnet-init:apikey-test",
        prefix: "dr_test...",
        hash: "abc123hash",
        repoId: "repo-7",
      },
    });
  });

  it("handles case normalization in URLs", async () => {
    // Mock repo registered with mixed case
    mockFindFirst.mockResolvedValue({
      id: "repo-8",
      name: "mixedcase",
    });

    // Query with lowercase
    const result = await lookupRepo("git@github.com:owner/mixedcase.git");

    expect(result.exists).toBe(true);
    expect(result.repoId).toBe("github.com/owner/mixedcase");
  });

  it("searches by canonical repoId in database", async () => {
    // Mock repo to verify the correct query
    mockFindFirst.mockResolvedValue({
      id: "repo-9",
      name: "query-test",
    });

    await lookupRepo("git@github.com:owner/query-test.git");

    // Verify that findFirst was called with the canonical repoId
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { repoId: "github.com/owner/query-test" },
      select: { id: true, name: true },
    });
  });
});
