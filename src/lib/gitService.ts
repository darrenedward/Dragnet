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
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { buildSshEnv } from "./gitRemote";
import type { RunResult } from "./containerOrchestratorTypes";
import { ContainerOrchestrator } from "./containerOrchestrator";
import { shellEscape } from "./shellEscape";

export interface SyncOptions {
  repoId: string;
  volumeName: string;
  cloneUrl: string;
  commitHash: string;
  deployKey?: string;
  pat?: string;
}

export interface GitServiceInterface {
  /** Clone or fetch a remote repo into a named Docker volume, then
   *  checkout the given commit hash. Returns the working directory path
   *  inside the container (always /workspace). */
  syncToCommit(opts: SyncOptions): Promise<string>;
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
