/**
 * #122 — SHA diffs vs PR target branch + stacked PR discovery.
 *
 * Stacked PR: parent branch is not main. Diff against parent tip must
 * not flood the child PR with parent-stack noise versus main.
 * Identity from resolveCommitIdentity must match the SHAs refresh uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommitIdentity } from "../../src/lib/reviewTree";
import { resolveDiffBaseBranch } from "../../src/lib/getRealPrs";

const mocks = vi.hoisted(() => ({
  mockRepoFindUnique: vi.fn(),
  mockPrFindUnique: vi.fn(),
  mockPrFileDeleteMany: vi.fn(),
  mockPrFileCreateMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.mockRepoFindUnique,
    },
    pullRequest: {
      findUnique: mocks.mockPrFindUnique,
    },
    prFile: {
      deleteMany: mocks.mockPrFileDeleteMany,
      createMany: mocks.mockPrFileCreateMany,
    },
  },
}));

// Real git via repoAccess — do not mock runGitInRepo.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * main → parent-stack (parent-only file) → child-stack (child-only file).
 * Child PR targets parent-stack, not main.
 */
function initStackedRepo(): {
  root: string;
  mainSha: string;
  parentSha: string;
  childSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dragnet-stack-diff-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "test@dragnet.local"]);
  git(root, ["config", "user.name", "Test"]);

  writeFileSync(join(root, "base.ts"), "export const base = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "main base"]);
  const mainSha = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "-b", "parent-stack"]);
  writeFileSync(join(root, "parent-only.ts"), "export const parent = 'stack';\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "shared.ts"), "export const shared = 'parent';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "parent stack work"]);
  const parentSha = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "-b", "child-stack"]);
  writeFileSync(join(root, "child-only.ts"), "export const child = 'tip';\n");
  writeFileSync(join(root, "src", "shared.ts"), "export const shared = 'child';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "child stack work"]);
  const childSha = git(root, ["rev-parse", "HEAD"]);

  // Ambient checkout on main (does not affect SHA diffs).
  git(root, ["checkout", "-q", "main"]);

  return { root, mainSha, parentSha, childSha };
}

describe("resolveDiffBaseBranch", () => {
  it("prefers PR target branch over repo default base", () => {
    expect(resolveDiffBaseBranch("parent-stack", "main")).toBe("parent-stack");
  });

  it("falls back to repo default base when target missing", () => {
    expect(resolveDiffBaseBranch("", "main")).toBe("main");
    expect(resolveDiffBaseBranch(null, "develop")).toBe("develop");
    expect(resolveDiffBaseBranch(undefined, undefined)).toBe("main");
  });
});

describe("stacked target base + SHA identity", () => {
  let root: string;
  let mainSha: string;
  let parentSha: string;
  let childSha: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const r = initStackedRepo();
    root = r.root;
    mainSha = r.mainSha;
    parentSha = r.parentSha;
    childSha = r.childSha;
    mocks.mockPrFileDeleteMany.mockResolvedValue({ count: 0 });
    mocks.mockPrFileCreateMany.mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolveCommitIdentity baseSha is parent tip when target is parent-stack", async () => {
    const id = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: childSha,
        sourceBranch: "child-stack",
        targetBranch: "parent-stack",
      },
    );
    expect(id.headSha).toBe(childSha);
    expect(id.baseSha).toBe(parentSha);
    expect(id.baseSha).not.toBe(mainSha);
  });

  it("refreshPrFiles stacked target is not entire stack vs main", async () => {
    mocks.mockRepoFindUnique.mockResolvedValue({ id: "r1", baseBranch: "main" });
    mocks.mockPrFindUnique.mockResolvedValue({
      targetBranch: "parent-stack",
      commitHash: childSha,
      sourceBranch: "child-stack",
    });

    const { refreshPrFiles } = await import("../../src/lib/getRealPrs");
    let captured: { headSha: string; baseSha: string } | null = null;
    const files = await refreshPrFiles(
      { id: "r1", path: root },
      "child-stack",
      "pr-stacked-1",
      {
        onIdentity: (id) => {
          captured = id;
        },
      },
    );

    const names = files.map((f) => f.filename).sort();
    // Child-only changes vs parent — not parent-only.ts (that is parent vs main).
    expect(names).toContain("child-only.ts");
    expect(names).toContain("src/shared.ts");
    expect(names).not.toContain("parent-only.ts");
    expect(names).not.toContain("base.ts");

    // Wrong base (main) would include parent-only.ts — prove we did not.
    const vsMain = execFileSync(
      "git",
      ["-C", root, "diff", "--name-only", `${mainSha}...${childSha}`],
      { encoding: "utf8" },
    );
    expect(vsMain).toContain("parent-only.ts");
    expect(names.join("\n")).not.toContain("parent-only.ts");
  });

  it("SHA identity from refresh matches resolveCommitIdentity", async () => {
    mocks.mockRepoFindUnique.mockResolvedValue({ id: "r1", baseBranch: "main" });
    mocks.mockPrFindUnique.mockResolvedValue({
      targetBranch: "parent-stack",
      commitHash: childSha,
      sourceBranch: "child-stack",
    });

    const expected = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: childSha,
        sourceBranch: "child-stack",
        targetBranch: "parent-stack",
      },
    );

    const { refreshPrFiles } = await import("../../src/lib/getRealPrs");
    let fromRefresh: { headSha: string; baseSha: string } | null = null;
    await refreshPrFiles({ id: "r1", path: root }, "child-stack", "pr-id-match", {
      onIdentity: (id) => {
        fromRefresh = id;
      },
    });

    expect(fromRefresh).not.toBeNull();
    expect(fromRefresh!.headSha).toBe(expected.headSha);
    expect(fromRefresh!.baseSha).toBe(expected.baseSha);
    expect(fromRefresh!.headSha).toBe(childSha);
    expect(fromRefresh!.baseSha).toBe(parentSha);
  });

  it("falls back to repo default base when PR target is missing", async () => {
    mocks.mockRepoFindUnique.mockResolvedValue({ id: "r1", baseBranch: "main" });
    mocks.mockPrFindUnique.mockResolvedValue({
      targetBranch: "",
      commitHash: childSha,
      sourceBranch: "child-stack",
    });

    const { refreshPrFiles } = await import("../../src/lib/getRealPrs");
    let captured: { headSha: string; baseSha: string } | null = null;
    const files = await refreshPrFiles(
      { id: "r1", path: root },
      "child-stack",
      "pr-no-target",
      {
        onIdentity: (id) => {
          captured = id;
        },
      },
    );

    expect(captured!.baseSha).toBe(mainSha);
    // vs main includes parent-stack noise
    const names = files.map((f) => f.filename);
    expect(names).toContain("parent-only.ts");
    expect(names).toContain("child-only.ts");
  });
});
