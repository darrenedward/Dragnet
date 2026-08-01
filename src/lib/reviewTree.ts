/**
 * Tip-bound review tree — commit identity + ensure-review-tree seam.
 *
 * Every PR scan pins to one head SHA (PR tip) and one base SHA before LLM
 * work. Agent readFile (and future tip consumers) read through this seam so
 * ambient host checkouts (main) and fake container paths (/workspace on the
 * host) never supply tip content by accident.
 */

import type { RepoLike, GitResult } from "./repoAccess";
import { runGitInRepo } from "./repoAccess";

export type ReadSourceMode = "git-show" | "git-show+pr-file" | "pr-file" | "none";

export interface CommitIdentity {
  headSha: string;
  baseSha: string;
}

export interface ReviewTree {
  readonly headSha: string;
  readonly baseSha: string;
  /**
   * How tip bytes are obtained. Never "ambient-checkout".
   * rootPath stays null in MVP — reads go through git-show / pr-file cache
   * so host working-tree state cannot leak tip content.
   */
  readonly readSource: ReadSourceMode;
  readonly rootPath: null;
  readFile(repoRelativePath: string): Promise<string | null>;
}

export interface ReviewTreeRepo extends RepoLike {
  baseBranch?: string | null;
}

export interface ResolveCommitIdentityPr {
  commitHash: string;
  sourceBranch: string;
  targetBranch: string;
}

export type RunGitFn = (
  repo: RepoLike,
  args: string[],
  opts?: { timeoutMs?: number; commitHash?: string },
) => Promise<GitResult>;

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Reject path traversal / absolute paths before any git show. */
export function isSafeRepoRelativePath(candidate: string): boolean {
  if (typeof candidate !== "string") return false;
  const p = candidate.trim();
  if (!p || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (p.includes("\0")) return false;
  const parts = p.split(/[/\\]/);
  for (const part of parts) {
    if (part === "..") return false;
  }
  // Normalize-ish: reject Windows drive prefixes
  if (/^[a-zA-Z]:/.test(p)) return false;
  return true;
}

async function revParse(
  repo: RepoLike,
  ref: string,
  runGit: RunGitFn,
): Promise<string | null> {
  if (!ref || !ref.trim()) return null;
  const candidates = [ref];
  // Prefer full refs for branch names so ambiguous short names don't bite.
  if (!SHA_RE.test(ref) && !ref.startsWith("refs/")) {
    candidates.unshift(`refs/heads/${ref}`);
  }
  for (const c of candidates) {
    const r = await runGit(repo, ["rev-parse", "--verify", `${c}^{commit}`]);
    if (r.exitCode === 0) {
      const sha = r.stdout.trim();
      if (SHA_RE.test(sha)) return sha;
    }
  }
  return null;
}

/**
 * Resolve the head (PR tip) and base SHAs used for this scan.
 *
 * headSha = provider head when it is a SHA (verified in clone when possible,
 * otherwise trusted as-is so a missing object never substitutes a different
 * source-branch tip). When provider head is empty/non-SHA, rev-parse source
 * branch.
 * baseSha = tip of PR target branch, else repo default base branch tip.
 */
export async function resolveCommitIdentity(
  repo: ReviewTreeRepo,
  pr: ResolveCommitIdentityPr,
  deps: { runGit?: RunGitFn } = {},
): Promise<CommitIdentity> {
  const runGit = deps.runGit ?? runGitInRepo;

  let headSha: string | null = null;
  const providerHead = (pr.commitHash || "").trim();
  if (providerHead && SHA_RE.test(providerHead)) {
    headSha = await revParse(repo, providerHead, runGit);
    if (!headSha) {
      // Trust provider SHA when it does not verify yet (shallow / not
      // fetched). Do NOT fall through to source-branch tip — that can be a
      // different commit and would pin the wrong head (and overwrite the
      // provider SHA on the PR row).
      headSha = providerHead;
    }
  }
  if (!headSha && pr.sourceBranch) {
    headSha = await revParse(repo, pr.sourceBranch, runGit);
  }
  if (!headSha) {
    throw new Error(
      `Cannot resolve PR head SHA (commitHash=${pr.commitHash || "(empty)"}, sourceBranch=${pr.sourceBranch || "(empty)"})`,
    );
  }

  let baseSha: string | null = null;
  if (pr.targetBranch) {
    baseSha = await revParse(repo, pr.targetBranch, runGit);
  }
  if (!baseSha && repo.baseBranch) {
    baseSha = await revParse(repo, repo.baseBranch, runGit);
  }
  if (!baseSha) {
    baseSha = await revParse(repo, "main", runGit);
  }
  if (!baseSha) {
    baseSha = await revParse(repo, "master", runGit);
  }
  if (!baseSha) {
    throw new Error(
      `Cannot resolve PR base SHA (targetBranch=${pr.targetBranch || "(empty)"}, baseBranch=${repo.baseBranch || "(empty)"})`,
    );
  }

  return { headSha, baseSha };
}

export interface EnsureReviewTreeOpts {
  repo: ReviewTreeRepo;
  headSha: string;
  baseSha: string;
  /** Tip content for changed files (from PrFile.modifiedContent). */
  prFileContents?: ReadonlyMap<string, string> | Record<string, string>;
  runGit?: RunGitFn;
}

function lookupPrFile(
  cache: EnsureReviewTreeOpts["prFileContents"],
  path: string,
): string | undefined {
  if (!cache) return undefined;
  if (cache instanceof Map) return cache.get(path);
  return cache[path];
}

/**
 * Materialize a tip-bound reader for the scan. Prefer git-show at headSha
 * (works while host checkout stays on main). Changed-file bytes may come
 * from the PrFile cache. Never exposes ambient repo.path as a free read root.
 */
export async function ensureReviewTree(opts: EnsureReviewTreeOpts): Promise<ReviewTree> {
  const { repo, headSha, baseSha } = opts;
  if (!headSha || !SHA_RE.test(headSha)) {
    throw new Error(`ensureReviewTree: invalid headSha ${headSha}`);
  }
  if (!baseSha || !SHA_RE.test(baseSha)) {
    throw new Error(`ensureReviewTree: invalid baseSha ${baseSha}`);
  }

  const runGit = opts.runGit ?? runGitInRepo;
  const hasPrCache = Boolean(
    opts.prFileContents &&
      (opts.prFileContents instanceof Map
        ? opts.prFileContents.size > 0
        : Object.keys(opts.prFileContents).length > 0),
  );

  // Access mode decides whether we can git-show. Fake host /workspace is
  // never used as a filesystem root here.
  let canGitShow = false;
  try {
    if (repo.path || repo.cloneUrl) {
      // Probe that git is reachable; don't require head to be current HEAD.
      const probe = await runGit(repo, ["rev-parse", "--is-inside-work-tree"]);
      canGitShow = probe.exitCode === 0 && /true/i.test(probe.stdout);
      // Remote-volume without a live volume still returns exit != 0 — ok.
      if (!canGitShow && repo.path) {
        // Local path that isn't a git dir: still try show later.
        canGitShow = true;
      }
      if (!canGitShow && repo.cloneUrl && !repo.path) {
        // Allow git-show attempts; runGit may hit the volume.
        canGitShow = true;
      }
    }
  } catch {
    canGitShow = Boolean(repo.path || repo.cloneUrl);
  }

  let readSource: ReadSourceMode = "none";
  if (canGitShow && hasPrCache) readSource = "git-show+pr-file";
  else if (canGitShow) readSource = "git-show";
  else if (hasPrCache) readSource = "pr-file";

  const tree: ReviewTree = {
    headSha,
    baseSha,
    readSource,
    rootPath: null,
    async readFile(repoRelativePath: string): Promise<string | null> {
      if (!isSafeRepoRelativePath(repoRelativePath)) return null;
      const rel = repoRelativePath.trim().replace(/^\.\//, "");

      const cached = lookupPrFile(opts.prFileContents, rel);
      if (typeof cached === "string") return cached;

      if (!canGitShow) return null;

      // git show <head>:<path> — tip content independent of working tree.
      const result = await runGit(repo, ["show", `${headSha}:${rel}`]);
      if (result.exitCode !== 0) return null;
      return result.stdout;
    },
  };

  return tree;
}

/** Structured scan log line: head, base, read-source. */
export function formatTipIdentityLog(
  identity: CommitIdentity,
  readSource: ReadSourceMode,
): string {
  return `Tip identity — head=${identity.headSha} base=${identity.baseSha} read-source=${readSource}`;
}

/**
 * Build a pr-file content map from refreshPrFiles / DB rows for the tree cache.
 */
export function prFileContentMap(
  files: Array<{ filename: string; modifiedContent?: string | null }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) {
    if (f.filename && typeof f.modifiedContent === "string" && f.modifiedContent.length > 0) {
      out[f.filename] = f.modifiedContent;
    }
  }
  return out;
}
