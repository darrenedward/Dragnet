/**
 * Tip-aligned Tier 1 / Tier 2 check planning.
 *
 * Host Tier 1 must run only on a tree at the scan head SHA (ambient checkout
 * already at tip, or a detached worktree). Never silently lint main while
 * reviewing another tip. Tier 2 container checkout uses the same head SHA as
 * commit identity / tools. Local-only repos bind-mount the tip tree or skip
 * Tier 2 with an explicit reason — never empty clone URL sync.
 *
 * Shallow clones that hide merge-base deepen or fail closed with a clear gate.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RepoLike, GitResult } from "./repoAccess";
import { runGitInRepo } from "./repoAccess";
import type { HostTier1Repo } from "@/src/services/deterministicChecks/helpers";
import { shouldRunHostTier1 } from "@/src/services/deterministicChecks/helpers";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export type RunGitFn = (
  repo: RepoLike,
  args: string[],
  opts?: { timeoutMs?: number; commitHash?: string },
) => Promise<GitResult>;

export type HostTier1Plan =
  | {
      action: "run";
      rootPath: string;
      headSha: string;
      source: "ambient-tip" | "worktree";
      cleanup?: () => void;
    }
  | {
      action: "skip";
      headSha: string;
      reason: string;
    };

export type Tier2Plan =
  | {
      action: "sync";
      commitHash: string;
      cloneUrl: string;
    }
  | {
      action: "bind";
      commitHash: string;
      hostPath: string;
    }
  | {
      action: "skip";
      commitHash: string;
      reason: string;
    };

export type MergeBaseResult =
  | { ok: true; mergeBase: string; deepened: boolean }
  | { ok: false; gate: "merge-base-unavailable"; message: string; deepened: boolean };

/**
 * Prefer tip-tree head, then review-run commit, then PR commitHash.
 * Callers must pass the same identity tools use.
 */
export function resolveCheckHeadSha(opts: {
  tipHeadSha?: string | null;
  reviewRunCommitHash?: string | null;
  prCommitHash?: string | null;
}): string {
  for (const candidate of [opts.tipHeadSha, opts.reviewRunCommitHash, opts.prCommitHash]) {
    const s = (candidate ?? "").trim();
    if (s && SHA_RE.test(s)) return s;
  }
  for (const candidate of [opts.tipHeadSha, opts.reviewRunCommitHash, opts.prCommitHash]) {
    const s = (candidate ?? "").trim();
    if (s) return s;
  }
  return "";
}

export function readLocalHead(repoPath: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return SHA_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

function fullShaEqual(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  // Allow abbreviated match when one is a prefix of the other (min 7).
  if (x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))) {
    return true;
  }
  return false;
}

/**
 * Create a detached worktree at headSha under a temp directory.
 * Returns null when the object is missing or worktree add fails.
 */
export function materializeTipWorktree(
  repoPath: string,
  headSha: string,
): { path: string; cleanup: () => void } | null {
  if (!repoPath || !headSha || !existsSync(repoPath)) return null;
  let workDir: string | null = null;
  try {
    // Verify object exists before allocating a worktree path.
    execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", `${headSha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    workDir = mkdtempSync(join(tmpdir(), "dragnet-tip-"));
    execFileSync(
      "git",
      ["-C", repoPath, "worktree", "add", "--detach", workDir, headSha],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    const dir = workDir;
    return {
      path: dir,
      cleanup: () => {
        try {
          execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", dir], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 30_000,
          });
        } catch {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      },
    };
  } catch {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return null;
  }
}

export type PlanHostTier1Deps = {
  currentHead?: (path: string) => string | null;
  materializeWorktree?: (
    repoPath: string,
    headSha: string,
  ) => { path: string; cleanup: () => void } | null;
};

/**
 * Plan host Tier 1: run only when the tree is at headSha (ambient or worktree).
 * Otherwise skip with an explicit reason — never lint an arbitrary host branch.
 */
export function planHostTier1(
  repo: HostTier1Repo | null | undefined,
  headSha: string,
  deps: PlanHostTier1Deps = {},
): HostTier1Plan {
  const sha = (headSha || "").trim();
  if (!shouldRunHostTier1(repo)) {
    const reason =
      repo?.cloneUrl || repo?.localPath === "/workspace"
        ? "remote/volume-backed repo uses container Tier 2 only"
        : "no meaningful local checkout for host Tier 1";
    return { action: "skip", headSha: sha, reason };
  }
  if (!sha) {
    return {
      action: "skip",
      headSha: "",
      reason: "no head SHA for tip-aligned Tier 1",
    };
  }
  const path = repo!.path!;
  const currentHead = deps.currentHead ?? readLocalHead;
  const ambient = currentHead(path);
  if (ambient && fullShaEqual(ambient, sha)) {
    return {
      action: "run",
      rootPath: path,
      headSha: sha,
      source: "ambient-tip",
    };
  }

  const materialize = deps.materializeWorktree ?? materializeTipWorktree;
  const wt = materialize(path, sha);
  if (wt) {
    return {
      action: "run",
      rootPath: wt.path,
      headSha: sha,
      source: "worktree",
      cleanup: wt.cleanup,
    };
  }

  const ambientNote = ambient
    ? `host HEAD=${ambient.slice(0, 12)} ≠ tip ${sha.slice(0, 12)}`
    : "host HEAD unreadable";
  return {
    action: "skip",
    headSha: sha,
    reason: `Tier 1 skipped: tip tree not materialized (${ambientNote}; worktree failed). Never linting ambient checkout while reviewing another tip.`,
  };
}

/**
 * Host path safe for Tier 2 container bind-mount (rw install/test).
 *
 * Never returns an ambient checkout — `npm install` would write node_modules
 * into the user's working tree. Reuses a Tier 1 worktree when present;
 * materializes a detached worktree when Tier 1 ran on ambient-tip.
 * Remote repos (clone URL) do not need a bind path (volume sync).
 */
export function planTier2BindRoot(
  tier1Plan: HostTier1Plan,
  opts: {
    cloneUrl?: string | null;
    /** Git dir used to materialize a worktree when Tier 1 was ambient-tip. */
    repoPath?: string | null;
    materializeWorktree?: (
      repoPath: string,
      headSha: string,
    ) => { path: string; cleanup: () => void } | null;
  } = {},
): { path: string | null; cleanup?: () => void } {
  if ((opts.cloneUrl ?? "").trim()) {
    return { path: null };
  }
  if (tier1Plan.action !== "run") {
    return { path: null };
  }
  if (tier1Plan.source === "worktree") {
    return { path: tier1Plan.rootPath };
  }
  // ambient-tip: isolate for container rw
  const gitDir = (opts.repoPath ?? "").trim() || tier1Plan.rootPath;
  const materialize = opts.materializeWorktree ?? materializeTipWorktree;
  const wt = materialize(gitDir, tier1Plan.headSha);
  if (!wt) return { path: null };
  return { path: wt.path, cleanup: wt.cleanup };
}

/**
 * Plan Tier 2 container checks against the same head SHA tools use.
 * Local-only (no clone URL): bind-mount tip root when available, else skip.
 */
export function planTier2(opts: {
  headSha: string;
  cloneUrl?: string | null;
  /** Tip-aligned host path (worktree only — never ambient) for bind-mount. */
  tipRootPath?: string | null;
  skipTier2?: boolean;
  tier1HadErrors?: boolean;
  tier2Supported?: boolean;
  hasPathOrClone?: boolean;
}): Tier2Plan {
  const commitHash = (opts.headSha || "").trim();
  if (opts.skipTier2) {
    return { action: "skip", commitHash, reason: "per-repo toggle" };
  }
  if (opts.tier1HadErrors) {
    return { action: "skip", commitHash, reason: "Tier 1 found errors" };
  }
  if (opts.tier2Supported === false) {
    return { action: "skip", commitHash, reason: "unsupported build system (non-Node.js)" };
  }
  if (!commitHash) {
    return { action: "skip", commitHash: "", reason: "no head SHA for tip-aligned Tier 2" };
  }

  const cloneUrl = (opts.cloneUrl ?? "").trim();
  if (cloneUrl) {
    return { action: "sync", commitHash, cloneUrl };
  }

  // Local-only: bind-mount tip tree when we have one at head.
  const tipRoot = (opts.tipRootPath ?? "").trim();
  if (tipRoot) {
    return { action: "bind", commitHash, hostPath: tipRoot };
  }

  if (opts.hasPathOrClone === false) {
    return { action: "skip", commitHash, reason: "no repo path or clone URL" };
  }

  return {
    action: "skip",
    commitHash,
    reason:
      "local-only repo: no clone URL for container sync and no tip worktree/bind path — skip Tier 2 (not empty-URL pretend-sync)",
  };
}

async function isShallowRepo(repo: RepoLike, runGit: RunGitFn): Promise<boolean> {
  const r = await runGit(repo, ["rev-parse", "--is-shallow-repository"]);
  if (r.exitCode === 0 && /true/i.test(r.stdout.trim())) return true;
  return false;
}

/**
 * Ensure merge-base(base, head) is available. When shallow history hides it,
 * deepen (or unshallow) and retry. Fail closed with a clear gate message.
 */
export async function ensureMergeBase(opts: {
  repo: RepoLike;
  baseRef: string;
  headRef: string;
  runGit?: RunGitFn;
  /** Max deepen rounds (each adds --deepen=N). */
  maxDeepenAttempts?: number;
  deepenStep?: number;
}): Promise<MergeBaseResult> {
  const runGit = opts.runGit ?? runGitInRepo;
  const baseRef = opts.baseRef.trim();
  const headRef = opts.headRef.trim();
  if (!baseRef || !headRef) {
    return {
      ok: false,
      gate: "merge-base-unavailable",
      message: `merge-base unavailable: empty base or head ref (base=${baseRef || "(empty)"}, head=${headRef || "(empty)"})`,
      deepened: false,
    };
  }

  const maxAttempts = opts.maxDeepenAttempts ?? 3;
  const step = opts.deepenStep ?? 200;
  let deepened = false;

  const tryMergeBase = async (): Promise<string | null> => {
    const r = await runGit(opts.repo, ["merge-base", baseRef, headRef]);
    if (r.exitCode === 0) {
      const sha = r.stdout.trim();
      if (SHA_RE.test(sha)) return sha;
    }
    return null;
  };

  let mergeBase = await tryMergeBase();
  if (mergeBase) {
    return { ok: true, mergeBase, deepened: false };
  }

  const shallow = await isShallowRepo(opts.repo, runGit);
  if (!shallow) {
    return {
      ok: false,
      gate: "merge-base-unavailable",
      message: `merge-base unavailable for ${baseRef}...${headRef} (histories unrelated or missing objects)`,
      deepened: false,
    };
  }

  for (let i = 0; i < maxAttempts; i++) {
    // Prefer deepen; fall back to unshallow on last attempt.
    const deepenArgs =
      i === maxAttempts - 1
        ? ["fetch", "--unshallow", "--prune"]
        : ["fetch", `--deepen=${step}`, "--prune"];
    const fetchResult = await runGit(opts.repo, deepenArgs, { timeoutMs: 180_000 });
    deepened = true;
    if (fetchResult.exitCode !== 0) {
      // Some remotes reject --unshallow; try deepen once more then fail.
      const alt = await runGit(opts.repo, ["fetch", `--deepen=${step * 2}`, "--prune"], {
        timeoutMs: 180_000,
      });
      if (alt.exitCode !== 0) {
        return {
          ok: false,
          gate: "merge-base-unavailable",
          message: `merge-base unavailable for ${baseRef}...${headRef}: shallow deepen failed (${fetchResult.stderr || fetchResult.stdout || "fetch error"})`,
          deepened: true,
        };
      }
    }
    mergeBase = await tryMergeBase();
    if (mergeBase) {
      return { ok: true, mergeBase, deepened: true };
    }
  }

  return {
    ok: false,
    gate: "merge-base-unavailable",
    message: `merge-base unavailable for ${baseRef}...${headRef} after deepening shallow history — fail closed (diff/checks would be wrong)`,
    deepened: true,
  };
}
