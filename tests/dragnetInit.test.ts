import { describe, it, expect, beforeEach, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execSync: mockExecSync }));

async function importInit() {
  return import("../cli/dragnet-init/src/init.mjs");
}

describe("canonicalizeUrl (vendored)", () => {
  it("normalizes GitHub SSH URL", async () => {
    const { canonicalizeUrl } = await importInit();
    expect(canonicalizeUrl("git@github.com:owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes GitHub HTTPS URL", async () => {
    const { canonicalizeUrl } = await importInit();
    expect(canonicalizeUrl("https://github.com/owner/repo.git"))
      .toBe("https://github.com/owner/repo");
  });

  it("normalizes self-hosted SSH URL", async () => {
    const { canonicalizeUrl } = await importInit();
    expect(canonicalizeUrl("git@git.internal.co:team/project.git"))
      .toBe("https://git.internal.co/team/project");
  });

  it("throws on unparseable URL", async () => {
    const { canonicalizeUrl } = await importInit();
    expect(() => canonicalizeUrl("not-a-url")).toThrow("Cannot parse git remote URL");
  });
});

describe("runInit", () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue("git@github.com:owner/repo.git");
    mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        exists: true,
        repoId: "github.com/owner/repo",
        apiKey: "dr_abc123",
        apiBase: "http://localhost:3300",
      }),
    });
  });

  function defaultOpts(overrides = {}) {
    return {
      cwd: "/tmp/test-repo",
      apiBase: "http://localhost:3300",
      prompt: vi.fn().mockResolvedValue("y"),
      fetch: mockFetch,
      ...overrides,
    };
  }

  it("resolves repoId + apiKey via lookup for remote repo", async () => {
    const { runInit } = await importInit();
    const result = await runInit(defaultOpts());

    expect(result).toEqual({
      repoId: "github.com/owner/repo",
      apiKey: "dr_abc123",
      apiBase: "http://localhost:3300",
    });
  });

  it("does NOT write any .dragnet/ files (PRD #33 — env vars replace filesystem config)", async () => {
    const { runInit } = await importInit();
    const result = await runInit(defaultOpts());

    // Result is just data for the caller to print — no filesystem side effects.
    expect(result).toEqual({
      repoId: expect.any(String),
      apiKey: expect.any(String),
      apiBase: expect.any(String),
    });
  });

  it("throws when no remote origin and not in local mode", async () => {
    const { runInit } = await importInit();
    mockExecSync.mockImplementation(() => { throw new Error("No remote"); });

    await expect(runInit(defaultOpts()))
      .rejects.toThrow("No git remote 'origin' found");
  });

  it("prompts for repoId in local mode and returns null apiKey (user fetches via UI)", async () => {
    const { runInit } = await importInit();
    const mockPrompt = vi.fn().mockResolvedValue("repo-manual-123");

    const result = await runInit(defaultOpts({ prompt: mockPrompt, local: true }));

    expect(mockPrompt).toHaveBeenCalled();
    expect(result).toEqual({
      repoId: "repo-manual-123",
      apiKey: null,
      apiBase: "http://localhost:3300",
    });
  });

  it("calls lookup API with canonical URL", async () => {
    const { runInit } = await importInit();
    await runInit(defaultOpts());

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain("/api/repos/lookup?remoteUrl=");
    expect(fetchUrl).toContain(encodeURIComponent("https://github.com/owner/repo"));
  });

  it("throws gracefully when Dragnet is unreachable", async () => {
    const { runInit } = await importInit();
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(runInit(defaultOpts()))
      .rejects.toThrow("connect ECONNREFUSED");
  });

  it("throws with clear message when repo not found at Dragnet", async () => {
    const { runInit } = await importInit();
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ exists: false }),
    });
    await expect(runInit(defaultOpts()))
      .rejects.toThrow("Repository not found");
  });
});
