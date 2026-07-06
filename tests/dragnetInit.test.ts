import { describe, it, expect, beforeEach, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockAppendFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ execSync: mockExecSync }));
vi.mock("fs", () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  appendFileSync: mockAppendFileSync,
  readFileSync: mockReadFileSync,
}));

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

describe("shouldAddGitignore", () => {
  it("returns true when line not in gitignore", async () => {
    const { shouldAddGitignore } = await importInit();
    expect(shouldAddGitignore("node_modules/\n", ".dragnet/repo.json")).toBe(true);
  });

  it("returns false when line already in gitignore", async () => {
    const { shouldAddGitignore } = await importInit();
    expect(shouldAddGitignore(".dragnet/repo.json\n", ".dragnet/repo.json")).toBe(false);
  });

  it("returns true for empty gitignore", async () => {
    const { shouldAddGitignore } = await importInit();
    expect(shouldAddGitignore("", ".dragnet/repo.json")).toBe(true);
  });

  it("returns false when line is in gitignore without trailing newline", async () => {
    const { shouldAddGitignore } = await importInit();
    expect(shouldAddGitignore(".dragnet/repo.json", ".dragnet/repo.json")).toBe(false);
  });
});

describe("runInit", () => {
  let mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue("git@github.com:owner/repo.git");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("node_modules/\n");
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

  it("reads git remote and writes repo.json for remote repo", async () => {
    const { runInit } = await importInit();
    const result = await runInit(defaultOpts());

    expect(result).toEqual({
      repoId: "github.com/owner/repo",
      apiKey: "dr_abc123",
      apiBase: "http://localhost:3300",
    });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/tmp/test-repo/.dragnet",
      { recursive: true, mode: 0o700 },
    );

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-repo/.dragnet/repo.json",
      expect.stringContaining("github.com/owner/repo"),
      { mode: 0o600 },
    );
  });

  it("throws when no remote origin and not in local mode", async () => {
    const { runInit } = await importInit();
    mockExecSync.mockImplementation(() => { throw new Error("No remote"); });

    await expect(runInit(defaultOpts()))
      .rejects.toThrow("No git remote 'origin' found");
  });

  it("prompts for repoId in local mode", async () => {
    const { runInit } = await importInit();
    const mockPrompt = vi.fn().mockResolvedValue("repo-manual-123");
    mockExistsSync.mockReturnValue(false);

    const result = await runInit(defaultOpts({ prompt: mockPrompt, local: true }));

    expect(result).toEqual({
      repoId: "repo-manual-123",
      apiKey: "",
      apiBase: "http://localhost:3300",
    });

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/test-repo/.dragnet/repo.json",
      expect.stringContaining("repo-manual-123"),
      expect.anything(),
    );
  });

  it("calls lookup API with canonical URL", async () => {
    const { runInit } = await importInit();
    await runInit(defaultOpts());

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain("/api/repos/lookup?remoteUrl=");
    expect(fetchUrl).toContain(encodeURIComponent("https://github.com/owner/repo"));
  });

  it("writes apiKey from API response", async () => {
    const { runInit } = await importInit();
    await runInit(defaultOpts());

    const writeArg = mockWriteFileSync.mock.calls[0][1];
    const config = JSON.parse(writeArg);
    expect(config.apiKey).toBe("dr_abc123");
  });

  it("adds .dragnet/repo.json to gitignore on user confirmation", async () => {
    const { runInit } = await importInit();
    mockReadFileSync.mockReturnValue("node_modules/\n");
    await runInit(defaultOpts());

    expect(mockAppendFileSync).toHaveBeenCalledWith(
      "/tmp/test-repo/.gitignore",
      expect.stringContaining(".dragnet/repo.json"),
    );
  });

  it("skips gitignore update when user declines", async () => {
    const { runInit } = await importInit();
    mockReadFileSync.mockReturnValue("node_modules/\n");
    await runInit(defaultOpts({ prompt: vi.fn().mockResolvedValue("n") }));

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("skips gitignore update when already present", async () => {
    const { runInit } = await importInit();
    mockReadFileSync.mockReturnValue(".dragnet/repo.json\n");
    await runInit(defaultOpts());

    expect(mockAppendFileSync).not.toHaveBeenCalled();
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
