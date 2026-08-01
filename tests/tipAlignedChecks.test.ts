import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveCheckHeadSha,
  planHostTier1,
  planTier2,
  planTier2BindRoot,
  materializeTipWorktree,
  ensureMergeBase,
  readLocalHead,
} from "@/src/lib/tipAlignedChecks";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): { root: string; mainSha: string; tipSha: string } {
  const root = mkdtempSync(join(tmpdir(), "dragnet-tip-checks-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "main"]);
  const mainSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-b", "feature"]);
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "tip"]);
  const tipSha = git(root, ["rev-parse", "HEAD"]);
  // Leave ambient checkout on main (wrong tree for tip review).
  git(root, ["checkout", "main"]);
  return { root, mainSha, tipSha };
}

describe("resolveCheckHeadSha", () => {
  it("prefers tip head over review-run and PR commit", () => {
    expect(
      resolveCheckHeadSha({
        tipHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        reviewRunCommitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        prCommitHash: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("falls back to review-run then PR", () => {
    expect(
      resolveCheckHeadSha({
        tipHeadSha: null,
        reviewRunCommitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        prCommitHash: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(
      resolveCheckHeadSha({
        tipHeadSha: "",
        reviewRunCommitHash: null,
        prCommitHash: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    ).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });
});

describe("planHostTier1", () => {
  it("skips remote/volume repos without running ambient path", () => {
    const plan = planHostTier1(
      { path: "/host/mirror", cloneUrl: "https://github.com/acme/app.git" },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        currentHead: () => {
          throw new Error("must not read ambient head for remote");
        },
      },
    );
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.reason).toMatch(/remote\/volume/i);
    }
  });

  it("runs on ambient checkout only when HEAD equals tip", () => {
    const plan = planHostTier1(
      { path: "/local/repo", cloneUrl: null },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        currentHead: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        materializeWorktree: () => {
          throw new Error("should not materialize when ambient matches");
        },
      },
    );
    expect(plan).toMatchObject({
      action: "run",
      rootPath: "/local/repo",
      source: "ambient-tip",
    });
  });

  it("does not lint wrong ambient branch — worktree or explicit skip", () => {
    const plan = planHostTier1(
      { path: "/local/repo", cloneUrl: null },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        currentHead: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        materializeWorktree: () => null,
      },
    );
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.reason).toMatch(/never linting ambient/i);
      expect(plan.reason).toMatch(/bbbbbbbbbbbb/);
    }
  });

  it("uses materialized worktree when ambient HEAD ≠ tip", () => {
    const plan = planHostTier1(
      { path: "/local/repo", cloneUrl: null },
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        currentHead: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        materializeWorktree: () => ({
          path: "/tmp/tip-wt",
          cleanup: () => {},
        }),
      },
    );
    expect(plan).toMatchObject({
      action: "run",
      rootPath: "/tmp/tip-wt",
      source: "worktree",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });
});

describe("planTier2BindRoot", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("reuses Tier 1 worktree path for bind", () => {
    const bind = planTier2BindRoot(
      {
        action: "run",
        rootPath: "/tmp/tip-wt",
        headSha: head,
        source: "worktree",
      },
      { cloneUrl: null },
    );
    expect(bind.path).toBe("/tmp/tip-wt");
    expect(bind.cleanup).toBeUndefined();
  });

  it("never returns ambient checkout as bind path (isolates for rw install)", () => {
    const bind = planTier2BindRoot(
      {
        action: "run",
        rootPath: "/local/repo",
        headSha: head,
        source: "ambient-tip",
      },
      {
        cloneUrl: null,
        repoPath: "/local/repo",
        materializeWorktree: (repoPath, sha) => {
          expect(repoPath).toBe("/local/repo");
          expect(sha).toBe(head);
          return { path: "/tmp/isolated-tip-wt", cleanup: () => {} };
        },
      },
    );
    expect(bind.path).toBe("/tmp/isolated-tip-wt");
    expect(bind.path).not.toBe("/local/repo");
    expect(typeof bind.cleanup).toBe("function");
  });

  it("returns null bind path for remote (volume sync)", () => {
    const bind = planTier2BindRoot(
      {
        action: "run",
        rootPath: "/host/mirror",
        headSha: head,
        source: "ambient-tip",
      },
      {
        cloneUrl: "https://github.com/acme/app.git",
        materializeWorktree: () => {
          throw new Error("must not materialize for remote");
        },
      },
    );
    expect(bind.path).toBeNull();
  });
});

describe("planTier2", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("syncs remote repos to the tip head SHA (same as tools)", () => {
    const plan = planTier2({
      headSha: head,
      cloneUrl: "https://github.com/acme/app.git",
    });
    expect(plan).toEqual({
      action: "sync",
      commitHash: head,
      cloneUrl: "https://github.com/acme/app.git",
    });
  });

  it("bind-mounts local-only tip tree instead of empty clone URL sync", () => {
    const plan = planTier2({
      headSha: head,
      cloneUrl: null,
      tipRootPath: "/tmp/tip-wt",
    });
    expect(plan).toEqual({
      action: "bind",
      commitHash: head,
      hostPath: "/tmp/tip-wt",
    });
  });

  it("skips local-only clearly when no tip bind path (never empty-URL sync)", () => {
    const plan = planTier2({
      headSha: head,
      cloneUrl: "",
      tipRootPath: null,
      hasPathOrClone: true,
    });
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.reason).toMatch(/local-only/i);
      expect(plan.reason).toMatch(/not empty-URL/i);
      expect(plan.commitHash).toBe(head);
    }
  });

  it("uses the provided tip head SHA even when it differs from ambient", () => {
    const tip = "dddddddddddddddddddddddddddddddddddddddd";
    const plan = planTier2({
      headSha: tip,
      cloneUrl: "https://github.com/acme/app.git",
    });
    expect(plan.action).toBe("sync");
    if (plan.action === "sync") {
      expect(plan.commitHash).toBe(tip);
      expect(plan.commitHash).not.toBe(head);
    }
  });
});

describe("materializeTipWorktree (integration)", () => {
  let root = "";
  let tipSha = "";
  let mainSha = "";
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    const r = initRepo();
    root = r.root;
    tipSha = r.tipSha;
    mainSha = r.mainSha;
    cleanup = undefined;
  });

  afterEach(() => {
    cleanup?.();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("materializes tip tree while host stays on main", () => {
    expect(readLocalHead(root)).toBe(mainSha);
    const wt = materializeTipWorktree(root, tipSha);
    expect(wt).not.toBeNull();
    cleanup = wt!.cleanup;
    expect(readLocalHead(wt!.path)).toBe(tipSha);
    // Ambient host still on main — wrong checkout would lint this.
    expect(readLocalHead(root)).toBe(mainSha);
    const tipBody = execFileSync("cat", [join(wt!.path, "a.ts")], { encoding: "utf8" });
    const mainBody = execFileSync("cat", [join(root, "a.ts")], { encoding: "utf8" });
    expect(tipBody).toContain("a = 2");
    expect(mainBody).toContain("a = 1");
    expect(tipBody).not.toBe(mainBody);
  });

  it("planHostTier1 runs checks on tip worktree not ambient main", () => {
    const plan = planHostTier1(
      { path: root, cloneUrl: null },
      tipSha,
    );
    expect(plan.action).toBe("run");
    if (plan.action === "run") {
      expect(plan.source).toBe("worktree");
      cleanup = plan.cleanup;
      expect(readLocalHead(plan.rootPath)).toBe(tipSha);
      expect(plan.rootPath).not.toBe(root);
    }
  });
});

describe("ensureMergeBase", () => {
  it("returns merge-base when history is complete", async () => {
    const { root, mainSha, tipSha } = initRepo();
    try {
      // On feature we need both commits; init leaves us on main with tip as branch.
      git(root, ["checkout", "feature"]);
      const result = await ensureMergeBase({
        repo: { id: "r", path: root },
        baseRef: mainSha,
        headRef: tipSha,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mergeBase).toBe(mainSha);
        expect(result.deepened).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deepens or fails closed when shallow history hides merge-base", async () => {
    // Build a linear history, then shallow-clone so merge-base is missing.
    const bare = mkdtempSync(join(tmpdir(), "dragnet-shallow-src-"));
    const clone = mkdtempSync(join(tmpdir(), "dragnet-shallow-cl-"));
    try {
      git(bare, ["init", "-b", "main"]);
      git(bare, ["config", "user.email", "t@e.com"]);
      git(bare, ["config", "user.name", "T"]);
      // Create enough commits that depth=1 loses the merge-base ancestor.
      for (let i = 0; i < 8; i++) {
        writeFileSync(join(bare, "f.txt"), `v${i}\n`);
        git(bare, ["add", "."]);
        git(bare, ["commit", "-m", `c${i}`]);
      }
      const baseSha = git(bare, ["rev-parse", "HEAD~5"]);
      const headSha = git(bare, ["rev-parse", "HEAD"]);

      execFileSync(
        "git",
        ["clone", "--depth=1", `file://${bare}`, clone],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      // Shallow clone at HEAD only — baseSha object may be missing.
      const before = await ensureMergeBase({
        repo: { id: "r", path: clone },
        baseRef: baseSha,
        headRef: headSha,
        maxDeepenAttempts: 4,
        deepenStep: 5,
      });
      // Either deepened successfully to find merge-base, or failed closed.
      if (before.ok === true) {
        expect(before.deepened).toBe(true);
        expect(before.mergeBase).toMatch(/^[0-9a-f]+$/i);
      } else {
        expect(before.gate).toBe("merge-base-unavailable");
        expect(before.message).toMatch(/merge-base unavailable/i);
      }
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("fails closed with clear gate when refs missing and not shallow", async () => {
    const root = mkdtempSync(join(tmpdir(), "dragnet-mb-"));
    try {
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "t@e.com"]);
      git(root, ["config", "user.name", "T"]);
      writeFileSync(join(root, "x"), "1\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "only"]);
      const head = git(root, ["rev-parse", "HEAD"]);
      const result = await ensureMergeBase({
        repo: { id: "r", path: root },
        baseRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headRef: head,
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.gate).toBe("merge-base-unavailable");
        expect(result.message).toMatch(/merge-base unavailable/i);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tip-aligned checks vs wrong checkout (smoke)", () => {
  it("Tier1 root is tip while ambient is main; Tier2 plan pins tip SHA", () => {
    const { root, mainSha, tipSha } = initRepo();
    let cleanup: (() => void) | undefined;
    try {
      expect(readLocalHead(root)).toBe(mainSha);

      const tier1 = planHostTier1({ path: root, cloneUrl: null }, tipSha);
      expect(tier1.action).toBe("run");
      if (tier1.action !== "run") throw new Error("expected run");
      cleanup = tier1.cleanup;
      expect(readLocalHead(tier1.rootPath)).toBe(tipSha);
      expect(readLocalHead(root)).toBe(mainSha);

      const tier2Remote = planTier2({
        headSha: tipSha,
        cloneUrl: "https://example.com/r.git",
      });
      expect(tier2Remote).toMatchObject({ action: "sync", commitHash: tipSha });

      const tier2Local = planTier2({
        headSha: tipSha,
        cloneUrl: null,
        tipRootPath: tier1.rootPath,
      });
      expect(tier2Local).toMatchObject({
        action: "bind",
        commitHash: tipSha,
        hostPath: tier1.rootPath,
      });

      // Wrong checkout path must never be the Tier1 root when tips differ.
      expect(tier1.rootPath).not.toBe(root);
    } finally {
      cleanup?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
