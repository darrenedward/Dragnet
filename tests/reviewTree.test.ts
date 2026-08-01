import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCommitIdentity,
  ensureReviewTree,
  formatTipIdentityLog,
  isSafeRepoRelativePath,
  type CommitIdentity,
} from "../src/lib/reviewTree";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): { root: string; mainSha: string; tipSha: string; baseSha: string } {
  const root = mkdtempSync(join(tmpdir(), "dragnet-review-tree-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "test@dragnet.local"]);
  git(root, ["config", "user.name", "Test"]);

  writeFileSync(join(root, "shared.ts"), "export const v = 'main-shared';\n");
  writeFileSync(join(root, "only-main.ts"), "export const only = 'main';\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const app = 'main-app';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "main base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  const mainSha = baseSha;

  git(root, ["checkout", "-q", "-b", "feature/tip"]);
  writeFileSync(join(root, "shared.ts"), "export const v = 'tip-shared';\n");
  writeFileSync(join(root, "src", "app.ts"), "export const app = 'tip-app';\n");
  writeFileSync(join(root, "new-on-tip.ts"), "export const neu = 'tip-only';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "tip changes"]);
  const tipSha = git(root, ["rev-parse", "HEAD"]);

  // Leave host checkout on main so ambient disk differs from tip.
  git(root, ["checkout", "-q", "main"]);
  expect(readFileSync(join(root, "shared.ts"), "utf8")).toContain("main-shared");
  expect(tipSha).not.toBe(mainSha);

  return { root, mainSha, tipSha, baseSha };
}

describe("isSafeRepoRelativePath", () => {
  it("accepts normal relative paths", () => {
    expect(isSafeRepoRelativePath("src/app.ts")).toBe(true);
    expect(isSafeRepoRelativePath("shared.ts")).toBe(true);
  });

  it("rejects traversal and absolute paths", () => {
    expect(isSafeRepoRelativePath("../etc/passwd")).toBe(false);
    expect(isSafeRepoRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRepoRelativePath("foo/../../etc")).toBe(false);
    expect(isSafeRepoRelativePath("")).toBe(false);
  });
});

describe("resolveCommitIdentity", () => {
  let root: string;
  let tipSha: string;
  let baseSha: string;

  beforeEach(() => {
    const r = initRepo();
    root = r.root;
    tipSha = r.tipSha;
    baseSha = r.baseSha;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses provider head SHA when it resolves in the repo", async () => {
    const id = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: tipSha,
        sourceBranch: "feature/tip",
        targetBranch: "main",
      },
    );
    expect(id.headSha).toBe(tipSha);
    expect(id.baseSha).toBe(baseSha);
  });

  it("falls back to source branch tip when commitHash is empty", async () => {
    const id = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: "",
        sourceBranch: "feature/tip",
        targetBranch: "main",
      },
    );
    expect(id.headSha).toBe(tipSha);
    expect(id.baseSha).toBe(baseSha);
  });

  it("trusts provider SHA when it does not verify — does not substitute branch tip", async () => {
    const missingProvider = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const calls: string[][] = [];
    const id = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: missingProvider,
        sourceBranch: "feature/tip",
        targetBranch: "main",
      },
      {
        runGit: async (_repo, args) => {
          calls.push(args);
          // Provider head never verifies; branch tips would resolve if asked.
          if (args[0] === "rev-parse" && String(args[2] ?? args[1] ?? "").includes(missingProvider)) {
            return { stdout: "", stderr: "unknown revision", exitCode: 128 };
          }
          if (args[0] === "rev-parse" && String(args[2] ?? "").includes("feature/tip")) {
            return { stdout: `${tipSha}\n`, stderr: "", exitCode: 0 };
          }
          if (args[0] === "rev-parse" && String(args[2] ?? "").includes("main")) {
            return { stdout: `${baseSha}\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "unknown", exitCode: 128 };
        },
      },
    );
    expect(id.headSha).toBe(missingProvider);
    expect(id.headSha).not.toBe(tipSha);
    // Must not have asked for source-branch tip as a substitute head.
    const joined = calls.map((a) => a.join(" ")).join("\n");
    expect(joined).not.toMatch(/feature\/tip/);
    expect(id.baseSha).toBe(baseSha);
  });

  it("falls back to repo default base when target branch missing", async () => {
    const id = await resolveCommitIdentity(
      { id: "r1", path: root, baseBranch: "main" },
      {
        commitHash: tipSha,
        sourceBranch: "feature/tip",
        targetBranch: "",
      },
    );
    expect(id.baseSha).toBe(baseSha);
  });

  it("does not fall back to main when explicit target branch is missing from clone", async () => {
    await expect(
      resolveCommitIdentity(
        { id: "r1", path: root, baseBranch: "main" },
        {
          commitHash: tipSha,
          sourceBranch: "feature/tip",
          targetBranch: "parent-stack-missing",
        },
      ),
    ).rejects.toThrow(/targetBranch=parent-stack-missing not found/);
  });
});

describe("ensureReviewTree + tip-bound readFile", () => {
  let root: string;
  let tipSha: string;
  let baseSha: string;
  let mainSha: string;

  beforeEach(() => {
    const r = initRepo();
    root = r.root;
    tipSha = r.tipSha;
    baseSha = r.baseSha;
    mainSha = r.mainSha;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serves tip body for changed files while host checkout is on main", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });

    expect(tree.headSha).toBe(tipSha);
    expect(tree.baseSha).toBe(baseSha);
    expect(tree.readSource).toBe("git-show");

    const shared = await tree.readFile("shared.ts");
    expect(shared).toContain("tip-shared");
    expect(shared).not.toContain("main-shared");

    // Ambient disk still has main content — proves we did not read checkout.
    expect(readFileSync(join(root, "shared.ts"), "utf8")).toContain("main-shared");
  });

  it("serves tip body for unchanged files (not only the diff set)", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });
    // only-main.ts is identical on tip and main but must still come via tip SHA.
    const body = await tree.readFile("only-main.ts");
    expect(body).toContain("only = 'main'");
  });

  it("serves files that exist only on the tip", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });
    const neu = await tree.readFile("new-on-tip.ts");
    expect(neu).toContain("tip-only");
    // File is absent on ambient main checkout.
    expect(() => readFileSync(join(root, "new-on-tip.ts"), "utf8")).toThrow();
  });

  it("prefers pr-file cache for changed files when provided", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
      prFileContents: { "shared.ts": "export const v = 'from-pr-file';\n" },
    });
    expect(tree.readSource).toBe("git-show+pr-file");
    const body = await tree.readFile("shared.ts");
    expect(body).toContain("from-pr-file");
  });

  it("does not treat ambient repo.path content as tip without the seam", async () => {
    // If someone reads ambient disk at main they get main-shared; the seam
    // must never return that when head is tip.
    const ambient = readFileSync(join(root, "shared.ts"), "utf8");
    expect(ambient).toContain("main-shared");

    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });
    // rootPath is not ambient working tree for free reads
    expect(tree.rootPath).toBeNull();
    const tip = await tree.readFile("shared.ts");
    expect(tip).not.toEqual(ambient);
  });

  it("rejects path traversal in readFile", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });
    expect(await tree.readFile("../etc/passwd")).toBeNull();
    expect(await tree.readFile("/etc/passwd")).toBeNull();
  });

  it("returns null for missing paths on tip", async () => {
    const tree = await ensureReviewTree({
      repo: { id: "r1", path: root },
      headSha: tipSha,
      baseSha,
    });
    expect(await tree.readFile("does-not-exist.ts")).toBeNull();
  });

  it("does not use fake container host path /workspace as tip content", async () => {
    // Remote-like repo: path is null, only cloneUrl. Without a volume the
    // tree still binds identity; reads without git access return null rather
    // than opening host /workspace.
    const tree = await ensureReviewTree({
      repo: { id: "r-remote", path: null, cloneUrl: "https://example.com/o/r.git" },
      headSha: tipSha,
      baseSha,
      // Inject a fake runGit that would be used in volume mode — none here
      // means show fails closed.
      runGit: async () => ({ stdout: "", stderr: "not available", exitCode: 128 }),
    });
    expect(tree.rootPath).toBeNull();
    expect(tree.readSource).toMatch(/git-show/);
    // Must not succeed by reading host /workspace
    const body = await tree.readFile("shared.ts");
    expect(body).toBeNull();
  });
});

describe("formatTipIdentityLog", () => {
  it("includes head, base, and read-source", () => {
    const id: CommitIdentity = {
      headSha: "abc1234deadbeef",
      baseSha: "def5678cafebabe",
    };
    const line = formatTipIdentityLog(id, "git-show");
    expect(line).toContain("head=abc1234deadbeef");
    expect(line).toContain("base=def5678cafebabe");
    expect(line).toContain("read-source=git-show");
  });
});
