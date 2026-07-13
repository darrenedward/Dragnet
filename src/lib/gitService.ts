/**
 * GitService — abstracts all git operations (clone, fetch, checkout) so
 * the real host-dependent execFileSync calls can be replaced with a mock
 * in Vitest without needing a real git binary or network.
 *
 * Volumes: for remote repos Dragnet uses named Docker volumes
 * (dragnet-repo-<repoId>). GitService.syncToCommit mounts and works
 * inside that volume via a lightweight git container (alpine/git).
 * For local repos (`repo.path` is set, no cloneUrl), it reads from the
 * local path directly — no Docker involved.
 *
 * The singleton follows the same globalThis guard pattern used by
 * prisma.ts and llmClient.ts.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmdirSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RunResult } from "./containerOrchestratorTypes";
import { ContainerOrchestrator } from "./containerOrchestrator";
import { shellEscape } from "./shellEscape";

/**
 * Wrap a branch-name fragment for safe inclusion inside a single-quoted
 * shell token. An embedded `'` would terminate the outer `'…'` wrap, so
 * we close the current quote, emit a backslash-escaped `'`, and reopen.
 *
 * 'my'branch'  →  'my'\''branch'
 *
 * NB: this shares the underlying escape pattern with src/lib/shellEscape.ts
 * but is intentionally a separate helper — shellEscape is meant for a value
 * interpolated between bare quotes (`'${shellEscape(x)}'`); reusing it
 * here would emit the same sequence in a context where only the close/
 * reopen form makes sense. Either produces the right bytes today, but
 * they have different contracts and would diverge.
 */
function escapeForSingleQuotedRefspec(branch: string): string {
  return branch.replace(/'/g, "'\\''");
}

export function buildFetchRefspec(branches: string[]): string {
  return branches
    .map((b) => `'+refs/heads/${escapeForSingleQuotedRefspec(b)}:refs/heads/${escapeForSingleQuotedRefspec(b)}'`)
    .join(" ");
}

export function buildSshEnv(
  deployKey: string,
  keyId: string,
): { env: Record<string, string>; [Symbol.dispose](): void } {
  const baseTmp = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const keyDir = mkdtempSync(path.join(baseTmp, "dragnet-key-"));
  try {
    chmodSync(keyDir, 0o700);
  } catch {
    /* best-effort — mkdtempSync already creates with restrictive mode */
  }
  const keyFile = path.join(keyDir, "id_ed25519");
  writeFileSync(keyFile, deployKey, { mode: 0o600 });
  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`,
    },
    [Symbol.dispose](): void {
      try {
        unlinkSync(keyFile);
        rmdirSync(keyDir);
      } catch {
        /* best-effort */
      }
    },
  };
}

export interface SyncOptions {
  repoId: string;
  volumeName: string;
  cloneUrl: string;
  commitHash: string;
  deployKey?: string;
  pat?: string;
}

export interface SyncBranchOptions {
  repoId: string;
  volumeName: string;
  cloneUrl: string;
  /** Branch name to fetch + checkout (becomes the working tree's HEAD). */
  branch: string;
  /** Other branches to fetch (no checkout) — typically the base branch
   *  so diffs against it see the latest remote state. */
  alsoFetch?: string[];
  deployKey?: string;
  pat?: string;
}

export interface GitServiceInterface {
  /** Clone or fetch a remote repo into a named Docker volume, then
   *  checkout the given commit hash. Returns the working directory path
   *  inside the container (always /workspace). */
  syncToCommit(opts: SyncOptions): Promise<string>;
  /** Clone or fetch a remote repo and ensure the given branch (+ any
   *  auxiliary branches in `alsoFetch`) exist locally. Used by
   *  PR-detection code paths that don't have a specific commit hash
   *  (e.g. when GitHub provides the branch name but no SHA via the
   *  pulls API), or by file-refresh code that needs the base branch
   *  up-to-date so `git diff base...pr-branch` reports correctly. */
  syncToBranch(opts: SyncBranchOptions): Promise<string>;
  /** Get the HEAD commit hash from a local path (for local-mode repos). */
  currentHead(localPath: string): string | null;
}

class RealGitService implements GitServiceInterface {
  private static GIT_IMAGE = process.env.DRAGNET_GIT_IMAGE ?? "alpine/git";

  async syncToCommit(opts: SyncOptions): Promise<string> {
    const orchestrator = ContainerOrchestrator.getInstance();

    // Ensure the volume exists (no-op if already created).
    await orchestrator.createVolume(opts.volumeName);

    // Interpolate PAT into URL if present.
    let cloneUrl = opts.cloneUrl;
    if (opts.pat) {
      try {
        const u = new URL(opts.cloneUrl);
        if (u.protocol === "https:") {
          u.username = "x-access-token";
          u.password = opts.pat;
          cloneUrl = u.toString();
        }
      } catch {
        /* non-URL (SSH) — pat ignored, deployKey used instead */
      }
    }

    // Build the git sync script:
    //   1. Init the volume dir as a git repo if not already done.
    //   2. Set the remote (update if already set).
    //   3. Fetch.
    //   4. Checkout the exact commit hash.
    //   5. Clean untracked files (preserving node_modules via .gitignore).
    const escapedUrl = shellEscape(cloneUrl);
    const syncScript = [
      "set -e",
      "[ -d /workspace/.git ] || git init /workspace",
      "cd /workspace",
      `git remote get-url origin 2>/dev/null && git remote set-url origin '${escapedUrl}' || git remote add origin '${escapedUrl}'`,
      "git fetch origin --prune --depth=100",
      `git checkout -f '${shellEscape(opts.commitHash)}'`,
      "git clean -fd --exclude=node_modules --exclude=.next --exclude=dist",
    ].join(" && ");

    // Extra SSH env vars via GIT_SSH_COMMAND if using deploy key.
    const extraEnv: Record<string, string> = {};
    let result: RunResult;

    {
      using ssh = opts.deployKey
        ? buildSshEnv(opts.deployKey, `sync-${opts.repoId}`)
        : { env: {} as Record<string, string>, [Symbol.dispose]() {} };

      Object.assign(extraEnv, ssh.env);

      result = await orchestrator.runRunner({
        volumeName: opts.volumeName,
        image: RealGitService.GIT_IMAGE,
        commands: [syncScript],
        networkMode: "bridge",
        env: extraEnv,
        timeoutMs: 120_000,
      });
    }

    if (result.exitCode !== 0 && !result.timedOut) {
      throw new Error(
        `Git sync failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    if (result.timedOut) {
      throw new Error(`Git sync timed out after 120 s for repo ${opts.repoId}`);
    }

    return "/workspace";
  }

  /**
   * Like syncToCommit but for "I have a branch name, not a SHA". Used
   * by getRealPrs / refreshPrFiles so the local clone is guaranteed to
   * contain both the PR branch and the base branch (with `git fetch`
   * pulling the latest refs from origin first) before `git diff` runs
   * against it. Without this, a stale clone (4 days old, base branch
   * moved on remote) silently returns zero diffs → "No code changes
   * detected" → empty scan.
   */
  async syncToBranch(opts: SyncBranchOptions): Promise<string> {
    const orchestrator = ContainerOrchestrator.getInstance();

    // Ensure the volume exists (no-op if already created).
    await orchestrator.createVolume(opts.volumeName);

    // Interpolate PAT into URL if present.
    let cloneUrl = opts.cloneUrl;
    if (opts.pat) {
      try {
        const u = new URL(opts.cloneUrl);
        if (u.protocol === "https:") {
          u.username = "x-access-token";
          u.password = opts.pat;
          cloneUrl = u.toString();
        }
      } catch {
        /* non-URL (SSH) — pat ignored, deployKey used instead */
      }
    }

    // Steps:
    //   1. Init /workspace as a git repo if not already (volume is reused
    //      across scans, so .git may already exist).
    //   2. Set the remote URL (idempotent).
    //   3. Fetch the PR branch + any aux branches (shallow, --depth=100
    //      is enough — we're diffing, not auditing history).
    //   4. Checkout the PR branch as the working tree HEAD so subsequent
    //      `git diff base...branch` resolves against local refs.
    const escapedUrl = shellEscape(cloneUrl);
    const escapedBranch = shellEscape(opts.branch);
    // Fetch with explicit refspec mappings so BOTH the PR branch AND any
    // alsoFetch branches (e.g. the base branch) get their local refs
    // updated to match origin. Without this, `git fetch origin <branch>
    // <base>` writes commits to FETCH_HEAD but leaves refs/heads/<base>
    // stale — so `git diff <base>...<pr>` later runs against an out-of-date
    // base (or fails entirely on a fresh clone where refs/heads/<base>
    // was never created). Mirrors remoteFetchWorker.ts:96's
    // '+refs/heads/*:refs/heads/*' refspec, scoped to just the branches we
    // need. The leading '+' allows non-fast-forward (e.g. force-pushes).
    const allBranches = [opts.branch, ...(opts.alsoFetch ?? [])];
    const refspecs = buildFetchRefspec(allBranches);
    const syncScript = [
      "set -e",
      "[ -d /workspace/.git ] || git init /workspace",
      "cd /workspace",
      `git remote get-url origin 2>/dev/null && git remote set-url origin '${escapedUrl}' || git remote add origin '${escapedUrl}'`,
      // Prune so branches deleted on remote disappear locally too;
      // depth=100 is plenty for review use cases.
      `git fetch origin --prune --depth=100 ${refspecs}`.trim(),
      // Checkout the PR branch from the just-updated local ref. Using the
      // explicit ref (not FETCH_HEAD) avoids ambiguity when multiple
      // refspecs are fetched in one go.
      `git switch -C '${escapedBranch}' 'refs/heads/${escapedBranch}'`,
    ].join(" && ");

    const extraEnv: Record<string, string> = {};
    let result: RunResult;

    {
      using ssh = opts.deployKey
        ? buildSshEnv(opts.deployKey, `syncbranch-${opts.repoId}`)
        : { env: {} as Record<string, string>, [Symbol.dispose]() {} };

      Object.assign(extraEnv, ssh.env);

      result = await orchestrator.runRunner({
        volumeName: opts.volumeName,
        image: RealGitService.GIT_IMAGE,
        commands: [syncScript],
        networkMode: "bridge",
        env: extraEnv,
        timeoutMs: 120_000,
      });
    }

    if (result.exitCode !== 0 && !result.timedOut) {
      throw new Error(
        `Git syncToBranch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    if (result.timedOut) {
      throw new Error(`Git syncToBranch timed out after 120 s for repo ${opts.repoId}`);
    }

    return "/workspace";
  }

  currentHead(localPath: string): string | null {
    try {
      const out = execFileSync("git", ["-C", localPath, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      const hash = out.trim();
      return /^[0-9a-f]{7,40}$/i.test(hash) ? hash : null;
    } catch {
      return null;
    }
  }
}

// ---- Singleton plumbing (mirrors prisma.ts / llmClient.ts pattern) ----

const GLOBAL_KEY = "__dragnetGitService";

function getGitService(): GitServiceInterface {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new RealGitService();
  }
  return g[GLOBAL_KEY] as GitServiceInterface;
}

/** Replace the singleton — call this in Vitest beforeEach. */
export function setGitService(mock: GitServiceInterface): void {
  const g = globalThis as Record<string, unknown>;
  g[GLOBAL_KEY] = mock;
}

/** The active GitService instance. */
export const gitService: GitServiceInterface = new Proxy({} as GitServiceInterface, {
  get(_target, prop) {
    return ((getGitService() as unknown) as Record<string, unknown>)[prop as string];
  },
});
