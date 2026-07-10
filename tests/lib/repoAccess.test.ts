import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  mockSyncToCommit: vi.fn(),
  mockRunRunner: vi.fn(),
}));

vi.mock("../../src/lib/gitService", () => ({
  gitService: {
    syncToCommit: mocks.mockSyncToCommit,
  },
}));

vi.mock("../../src/lib/containerOrchestrator", () => {
  const MockOrchestrator = class {
    static getInstance() { return new MockOrchestrator(); }
    static setInstance(_i: unknown) { /* noop */ }
    runRunner = mocks.mockRunRunner;
  };
  return {
    ContainerOrchestrator: MockOrchestrator,
  };
});

async function getMod() {
  return import("../../src/lib/repoAccess");
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  if (!process.env.DRAGNET_MASTER_KEY) {
    process.env.DRAGNET_MASTER_KEY = "QQe7IAjrJKIUR/yBCcjdW91OJXQt2zVQsm9NvZqXjzc=";
  }
  tmpDir = mkdtempSync(join(tmpdir(), "dragnet-repo-access-"));
  // Initialize as a real git repo so `git status` / `git rev-parse HEAD` work.
  execFileSync("git", ["init", "-q", tmpDir]);
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@dragnet.local"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
  writeFileSync(join(tmpDir, "README.md"), "test\n");
  execFileSync("git", ["-C", tmpDir, "add", "README.md"]);
  execFileSync("git", ["-C", tmpDir, "commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveRepoAccess", () => {
  it("returns local-path when repo.path is set", async () => {
    const { resolveRepoAccess } = await getMod();
    const access = resolveRepoAccess({ id: "r1", path: "/some/path" });
    expect(access.mode).toBe("local-path");
    expect(access.volumeName).toBeUndefined();
  });

  it("returns remote-volume with derived volume name when cloneUrl is set", async () => {
    const { resolveRepoAccess } = await getMod();
    const access = resolveRepoAccess({ id: "abc-123", cloneUrl: "git@github.com:o/r.git" });
    expect(access.mode).toBe("remote-volume");
    expect(access.volumeName).toBe("dragnet-repo-abc-123");
  });

  it("throws when neither path nor cloneUrl is set", async () => {
    const { resolveRepoAccess } = await getMod();
    expect(() => resolveRepoAccess({ id: "r1" })).toThrow(/no path or cloneUrl/);
  });

  it("prefers path over cloneUrl when both set (legacy priority)", async () => {
    const { resolveRepoAccess } = await getMod();
    const access = resolveRepoAccess({ id: "r1", path: "/legacy", cloneUrl: "git@…/r.git" });
    expect(access.mode).toBe("local-path");
  });
});

describe("runGitInRepo — local-path mode", () => {
  it("returns stdout on success", async () => {
    const { runGitInRepo } = await getMod();
    const repo = { id: "r1", path: tmpDir };
    const { stdout, exitCode } = await runGitInRepo(repo, ["rev-parse", "HEAD"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("returns non-zero exit + stderr on git error", async () => {
    const { runGitInRepo } = await getMod();
    const repo = { id: "r1", path: tmpDir };
    const { exitCode, stderr } = await runGitInRepo(repo, ["cat-file", "-p", "deadbeefdeadbeef"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/not a git|ambiguous|unknown|bad|fatal/);
  });

  it("never throws on non-zero exit", async () => {
    const { runGitInRepo } = await getMod();
    const repo = { id: "r1", path: "/nonexistent/path/that/does/not/exist" };
    await expect(runGitInRepo(repo, ["rev-parse", "HEAD"])).resolves.toBeTruthy();
  });
});

describe("runGitInRepo — remote-volume mode", () => {
  it("calls orchestrator.runRunner with quoted args", async () => {
    mocks.mockRunRunner.mockResolvedValue({ stdout: "abc123\n", stderr: "", exitCode: 0, timedOut: false });
    const { runGitInRepo } = await getMod();
    const repo = {
      id: "remote-1",
      cloneUrl: "git@github.com:owner/repo.git",
    };
    const result = await runGitInRepo(repo, ["rev-parse", "HEAD"]);
    expect(result.stdout).toBe("abc123\n");
    expect(mocks.mockRunRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeName: "dragnet-repo-remote-1",
        image: "alpine/git",
        networkMode: "none",
      }),
    );
    expect(mocks.mockRunRunner.mock.calls[0][0].commands[0]).toContain("git 'rev-parse' 'HEAD'");
  });

  it("skips syncToCommit when commitHash not provided", async () => {
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { runGitInRepo } = await getMod();
    const repo = { id: "remote-2", cloneUrl: "git@github.com:o/r.git" };
    await runGitInRepo(repo, ["status"]);
    expect(mocks.mockSyncToCommit).not.toHaveBeenCalled();
  });

  it("calls syncToCommit when commitHash provided", async () => {
    mocks.mockSyncToCommit.mockResolvedValue("/workspace");
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { runGitInRepo } = await getMod();
    const repo = { id: "remote-3", cloneUrl: "git@github.com:o/r.git" };
    await runGitInRepo(repo, ["rev-parse", "HEAD"], { commitHash: "deadbeef" });
    expect(mocks.mockSyncToCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: "remote-3",
        volumeName: "dragnet-repo-remote-3",
        cloneUrl: "git@github.com:o/r.git",
        commitHash: "deadbeef",
      }),
    );
  });

  it("decrypts deployKey when present", async () => {
    mocks.mockSyncToCommit.mockResolvedValue("/workspace");
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { encryptSecret } = await import("../../src/lib/crypto");
    const { cipher, iv, tag } = encryptSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n");
    const { runGitInRepo } = await getMod();
    const repo = {
      id: "remote-4",
      cloneUrl: "git@github.com:o/r.git",
      deployKeyCipher: cipher,
      deployKeyIv: iv,
      deployKeyTag: tag,
    };
    await runGitInRepo(repo, ["status"], { commitHash: "abc" });
    const callArgs = mocks.mockSyncToCommit.mock.calls[0][0];
    expect(callArgs.deployKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("decrypts pat when present (PAT takes precedence over nothing else)", async () => {
    mocks.mockSyncToCommit.mockResolvedValue("/workspace");
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { encryptSecret } = await import("../../src/lib/crypto");
    const { cipher, iv, tag } = encryptSecret("ghp_fakePAT123");
    const { runGitInRepo } = await getMod();
    const repo = {
      id: "remote-5",
      cloneUrl: "https://github.com/o/r.git",
      patCipher: cipher,
      patIv: iv,
      patTag: tag,
    };
    await runGitInRepo(repo, ["status"], { commitHash: "abc" });
    const callArgs = mocks.mockSyncToCommit.mock.calls[0][0];
    expect(callArgs.pat).toBe("ghp_fakePAT123");
    expect(callArgs.deployKey).toBeUndefined();
  });

  it("respects networkMode option for fetch operations", async () => {
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { runGitInRepo } = await getMod();
    const repo = { id: "remote-6", cloneUrl: "git@github.com:o/r.git" };
    await runGitInRepo(repo, ["fetch"], { networkMode: "bridge" });
    expect(mocks.mockRunRunner).toHaveBeenCalledWith(
      expect.objectContaining({ networkMode: "bridge" }),
    );
  });

  it("shell-escapes single quotes in args", async () => {
    mocks.mockRunRunner.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const { runGitInRepo } = await getMod();
    const repo = { id: "remote-7", cloneUrl: "git@github.com:o/r.git" };
    await runGitInRepo(repo, ["log", "--grep=don't break"]);
    expect(mocks.mockRunRunner.mock.calls[0][0].commands[0]).toBe(
      `git 'log' '--grep=don'\\''t break'`,
    );
  });

  it("throws when neither path nor cloneUrl set", async () => {
    const { runGitInRepo } = await getMod();
    await expect(runGitInRepo({ id: "r1" }, ["status"])).rejects.toThrow(/no path or cloneUrl/);
  });
});