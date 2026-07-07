import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  mockRunGitInRepo: vi.fn(),
  mockRepoFindUnique: vi.fn(),
  mockRepoFindMany: vi.fn(),
  mockPrFindMany: vi.fn(),
  mockPrDeleteMany: vi.fn(),
  mockPrUpsert: vi.fn(),
  mockPrFindUnique: vi.fn(),
  mockPrUpdate: vi.fn(),
  mockPrFileDeleteMany: vi.fn(),
  mockPrFileCreateMany: vi.fn(),
}));

vi.mock("../../src/lib/repoAccess", () => ({
  runGitInRepo: mocks.mockRunGitInRepo,
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.mockRepoFindUnique,
      findMany: mocks.mockRepoFindMany,
    },
    pullRequest: {
      findMany: mocks.mockPrFindMany,
      findUnique: mocks.mockPrFindUnique,
      deleteMany: mocks.mockPrDeleteMany,
      upsert: mocks.mockPrUpsert,
      update: mocks.mockPrUpdate,
    },
    prFile: {
      deleteMany: mocks.mockPrFileDeleteMany,
      createMany: mocks.mockPrFileCreateMany,
    },
  },
}));

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(join(tmpdir(), "dragnet-realprs-"));
  execFileSync("git", ["init", "-q", tmpDir]);
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@dragnet.local"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", tmpDir, "commit", "--allow-empty", "-q", "-m", "init"]);
});

async function getMod() {
  return import("../../src/lib/getRealLocalPrs");
}

describe("getRealLocalPrs — local-path mode", () => {
  it("returns null when path doesn't exist", async () => {
    const { getRealLocalPrs } = await getMod();
    const result = await getRealLocalPrs({ id: "r1", path: "/nonexistent/path/xyz" });
    expect(result).toBeNull();
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns null when not a git repo", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dragnet-empty-"));
    try {
      const { getRealLocalPrs } = await getMod();
      const result = await getRealLocalPrs({ id: "r1", path: emptyDir });
      expect(result).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("scans local repo branches and upserts PRs", async () => {
    const repo = { id: "r1", path: tmpDir };
    mocks.mockRepoFindUnique.mockResolvedValue({
      id: "r1",
      baseBranch: "main",
      branchPattern: "*",
    });
    mocks.mockPrFindMany.mockResolvedValue([]);
    mocks.mockPrFileCreateMany.mockResolvedValue({ count: 0 });

    // Create a feature branch with one file change
    execFileSync("git", ["-C", tmpDir, "checkout", "-q", "-b", "feature/x"]);
    execFileSync("git", ["-C", tmpDir, "checkout", "-q", "main"]);
    // Stub out the heavy git operations
    mocks.mockRunGitInRepo.mockImplementation(async (r, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "show-ref" && args[2] === "refs/heads/main") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "for-each-ref") {
        return {
          stdout: "feature/x|abc1234567890def|2026-01-01T00:00:00+00:00|Test|initial commit\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "merge-base") {
        // not merged
        return { stdout: "", stderr: "fatal: not a merge base", exitCode: 1 };
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return { stdout: "M\tx.ts\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "diff" && args.includes("--")) {
        return { stdout: "@@ -1 +1 @@\n-old\n+new\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "show") {
        return { stdout: "file content", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mocks.mockPrFindUnique.mockResolvedValue(null);

    const { getRealLocalPrs } = await getMod();
    const result = await getRealLocalPrs(repo);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].sourceBranch).toBe("feature/x");
    expect(mocks.mockPrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-pr-r1-feature-x" },
        create: expect.objectContaining({ sourceBranch: "feature/x", status: "Pending" }),
      }),
    );
  });
});

describe("getRealLocalPrs — remote-volume mode (uses runGitInRepo)", () => {
  it("dispatches git reads to runGitInRepo when cloneUrl is set", async () => {
    const repo = { id: "remote-r1", cloneUrl: "git@github.com:o/r.git" };
    mocks.mockRepoFindUnique.mockResolvedValue({
      id: "remote-r1",
      baseBranch: "main",
      branchPattern: "*",
    });
    mocks.mockPrFindMany.mockResolvedValue([]);
    mocks.mockPrFileCreateMany.mockResolvedValue({ count: 0 });
    mocks.mockPrFindUnique.mockResolvedValue(null);

    mocks.mockRunGitInRepo.mockImplementation(async (r, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "show-ref" && args[2] === "refs/heads/main") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "for-each-ref") {
        return {
          stdout: "feat/y|def456|2026-01-01T00:00:00+00:00|Author|subject\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "merge-base") {
        return { stdout: "", stderr: "not merged", exitCode: 1 };
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return { stdout: "", stderr: "", exitCode: 0 }; // no files
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const { getRealLocalPrs } = await getMod();
    const result = await getRealLocalPrs(repo);

    expect(mocks.mockRunGitInRepo).toHaveBeenCalledWith(
      expect.objectContaining({ cloneUrl: "git@github.com:o/r.git" }),
      ["rev-parse", "--is-inside-work-tree"],
      expect.any(Object),
    );
    // Empty diff → PR record IS created (0-diff branches no longer skipped)
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].sourceBranch).toBe("feat/y");
    expect(mocks.mockPrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-pr-remote-r1-feat-y" },
        create: expect.objectContaining({ sourceBranch: "feat/y", status: "Pending" }),
      }),
    );
  });

  it("creates PR record for 0-diff unmerged branch (not merged, but no file changes)", async () => {
    const repo = { id: "remote-r3", cloneUrl: "git@github.com:o/r.git" };
    mocks.mockRepoFindUnique.mockResolvedValue({
      id: "remote-r3",
      baseBranch: "main",
      branchPattern: "*",
    });
    mocks.mockPrFindMany.mockResolvedValue([]);
    mocks.mockPrFileCreateMany.mockResolvedValue({ count: 0 });
    mocks.mockPrFindUnique.mockResolvedValue(null);

    mocks.mockRunGitInRepo.mockImplementation(async (r, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "show-ref" && args[2] === "refs/heads/main") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "for-each-ref") {
        return {
          stdout: "zero-diff-branch|abc789|2026-06-01T00:00:00+00:00|Dev|empty change\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "merge-base") {
        return { stdout: "", stderr: "not merged", exitCode: 1 }; // not merged
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return { stdout: "", stderr: "", exitCode: 0 }; // 0 files changed
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const { getRealLocalPrs } = await getMod();
    const result = await getRealLocalPrs(repo);

    // PR record MUST be created even with 0 diffs
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].sourceBranch).toBe("zero-diff-branch");
    expect(mocks.mockPrUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-pr-remote-r3-zero-diff-branch" },
        create: expect.objectContaining({
          sourceBranch: "zero-diff-branch",
          status: "Pending",
          description: "empty change",
        }),
      }),
    );
    // prFile createMany should still be called (with empty data)
    expect(mocks.mockPrFileCreateMany).toHaveBeenCalled();
  });

  it("marks merged branches as Merged when found via for-each-ref", async () => {
    const repo = { id: "remote-r2", cloneUrl: "git@github.com:o/r.git" };
    mocks.mockRepoFindUnique.mockResolvedValue({
      id: "remote-r2",
      baseBranch: "main",
      branchPattern: "*",
    });
    mocks.mockPrFindMany.mockResolvedValue([]);
    mocks.mockRunGitInRepo.mockImplementation(async (r, args) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "for-each-ref") {
        return {
          stdout: "merged|abc123|2026-01-01T00:00:00+00:00|A|merged\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        // merged = true
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mocks.mockPrFindUnique.mockResolvedValue({ id: "real-pr-remote-r2-merged", status: "Open" });

    const { getRealLocalPrs } = await getMod();
    await getRealLocalPrs(repo);

    expect(mocks.mockPrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "real-pr-remote-r2-merged" },
        data: expect.objectContaining({ status: "Merged", commitHash: "abc123" }),
      }),
    );
  });
});

describe("isBranchMerged", () => {
  it("returns true when merge-base exits 0", async () => {
    const { isBranchMerged } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await isBranchMerged({ id: "r1", path: "/x" }, "main", "feat");
    expect(result).toBe(true);
  });

  it("returns false on non-zero exit", async () => {
    const { isBranchMerged } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "", stderr: "fatal", exitCode: 1 });
    const result = await isBranchMerged({ id: "r1", path: "/x" }, "main", "feat");
    expect(result).toBe(false);
  });
});