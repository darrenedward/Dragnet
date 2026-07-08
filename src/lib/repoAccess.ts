/**
 * repoAccess — unified git access for both local-path and remote-volume modes.
 *
 * Two repository modes coexist in the schema:
 *
 *   - **local-path** (legacy): `repo.path` is set to an absolute filesystem
 *     path on the host. The server reads git state directly from disk
 *     using `execFileSync("git", ["-C", path, ...])`. No Docker required.
 *
 *   - **remote-volume** (target): `repo.cloneUrl` is set and `repo.path` is
 *     null. The repo is cloned fresh into a named Docker volume
 *     (`dragnet-repo-<id>`) by `GitService.syncToCommit` (running an
 *     `alpine/git` sidecar). Subsequent git operations run inside another
 *     `alpine/git` container with that volume mounted at `/workspace`.
 *     Self-contained: every clone happens in the container, no host
 *     bind mount of the working tree is required.
 *
 * Every consumer that previously did `git -C repo.path …` should call
 * `runGitInRepo(repo, args)` instead. The helper picks the right mode
 * based on which fields are populated and returns the same `{stdout,
 * stderr, exitCode}` shape either way.
 *
 * This file is the first step of the remote-clone migration tracked in
 * `.agent-os/specs/2026-07-03-0900-hosted-scan-architecture/`. Each
 * subsequent PR replaces one more `repo.path` consumer with this
 * helper — the system stays working at every commit because legacy
 * repos keep using `repo.path` and migrated repos use the volume path.
 */

import { execFileSync } from "node:child_process";
import { gitService } from "./gitService";
import { ContainerOrchestrator } from "./containerOrchestrator";
import { decryptSecret } from "./crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RepoLike {
  id: string;
  /** Absolute filesystem path on the host (legacy mode). */
  path?: string | null;
  /** Remote git URL — cloneUrl is SSH (git@…), cloneUrlHttps is https. */
  cloneUrl?: string | null;
  cloneUrlHttps?: string | null;
  /** GitHub App installation ID (for repos imported via the GitHub App flow). */
  installationId?: string | null;
  /** Encrypted auth — either SSH deploy key OR GitHub PAT, never both. */
  deployKeyCipher?: string | null;
  deployKeyIv?: string | null;
  deployKeyTag?: string | null;
  patCipher?: string | null;
  patIv?: string | null;
  patTag?: string | null;
}

export type RepoAccessMode = "local-path" | "remote-volume";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitOptions {
  /** If set, ensures the repo is cloned + checked out at this commit first (remote mode only). */
  commitHash?: string;
  /** Per-call override; default 30s. */
  timeoutMs?: number;
  /** Remote-volume mode only: which network to attach to the alpine/git container. Default "none". */
  networkMode?: "none" | "bridge";
}

/**
 * Ensure the remote-mode clone is up-to-date and has both the PR branch
 * and the base branch available locally. Used by getRealPrs /
 * refreshPrFiles before running `git diff`. Without this, a stale
 * clone (4 days old, base branch moved on remote) silently returns an
 * empty diff and the scan runs against zero files.
 *
 * No-op for local-path repos (they're already on disk).
 *
 * Throws when the clone can't be refreshed so the caller can surface
 * a clear "clone sync failed" error instead of "no code changes".
 */
export async function syncCloneForPr(
  repo: RepoLike,
  branch: string,
  baseBranch: string,
): Promise<void> {
  if (repo.path) return; // local-path: no clone to sync
  if (!repo.cloneUrl) return; // nothing to sync
  const access = resolveRepoAccess(repo);
  if (access.mode !== "remote-volume") return; // belt + braces

  // Pick the auth that's actually valid for THIS URL. An HTTPS cloneUrl
  // can only be authenticated by a PAT (PAT is interpolated into the
  // URL before fetch); an SSH cloneUrl only works with a deploy key
  // (via GIT_SSH_COMMAND). Sending the wrong one causes git to either
  // ignore the SSH key and prompt for Username (exit 128 → "no such
  // device or address"), or push the bare URL with no creds.
  const isHttps = repo.cloneUrl.startsWith("https://") || repo.cloneUrl.startsWith("http://");
  let pat: string | undefined;
  let deployKey: string | undefined;
  if (isHttps) {
    pat =
      repo.patCipher && repo.patIv && repo.patTag
        ? decryptSecret(repo.patCipher, repo.patIv, repo.patTag)
        : undefined;
    // Only fall back to deploy key if the URL is SSH.
    if (!pat) deployKey = access.auth?.deployKey;
  } else {
    deployKey = access.auth?.deployKey;
  }

  const { gitService } = await import("./gitService");
  await gitService.syncToBranch({
    repoId: repo.id,
    volumeName: access.volumeName!,
    cloneUrl: repo.cloneUrl,
    branch,
    alsoFetch: [baseBranch],
    deployKey,
    pat,
  });
}

/**
 * Decide which mode a repo should be accessed in and return the
 * volume-name / path / auth needed to drive subsequent calls.
 *
 * Throws if the repo has neither `path` nor `cloneUrl` — that
 * represents a corrupt row and should never silently succeed.
 */
export function resolveRepoAccess(repo: RepoLike): {
  mode: RepoAccessMode;
  volumeName?: string;
  auth?: { deployKey?: string; pat?: string };
} {
  if (repo.path) {
    return { mode: "local-path" };
  }
  if (repo.cloneUrl) {
    return {
      mode: "remote-volume",
      volumeName: `dragnet-repo-${repo.id}`,
      auth: decryptAuth(repo),
    };
  }
  throw new Error(`Repo ${repo.id} has no path or cloneUrl — cannot resolve access`);
}

function decryptAuth(repo: RepoLike): { deployKey?: string; pat?: string } {
  if (repo.deployKeyCipher && repo.deployKeyIv && repo.deployKeyTag) {
    return {
      deployKey: decryptSecret(repo.deployKeyCipher, repo.deployKeyIv, repo.deployKeyTag),
    };
  }
  if (repo.patCipher && repo.patIv && repo.patTag) {
    return {
      pat: decryptSecret(repo.patCipher, repo.patIv, repo.patTag),
    };
  }
  return {};
}

/**
 * Run a read-only git command against a repo. Returns `{stdout, stderr,
 * exitCode}` — never throws on non-zero exit so callers can inspect
 * stderr and decide what to do. Throws only on infrastructure failures
 * (Docker engine down, malformed input, missing path, etc.).
 *
 * Usage:
 *   const { stdout } = await runGitInRepo(repo, ["rev-parse", "HEAD"]);
 *   const { stdout } = await runGitInRepo(repo, ["diff", base, head], { commitHash: head });
 *
 * For remote-volume mode, the alpine/git sidecar is run with the
 * repo's named volume mounted at /workspace. The args are joined with
 * shell-safe quoting (single-quote escape) and executed as one
 * `sh -c "git ..."` line. Pass `commitHash` to ensure the volume is
 * synced to that commit before the command runs.
 */
export async function runGitInRepo(
  repo: RepoLike,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  const access = resolveRepoAccess(repo);

  if (access.mode === "local-path") {
    return runLocalGit(access as { mode: "local-path" }, repo, args, opts);
  }
  return runVolumeGit(
    access as { mode: "remote-volume"; volumeName: string; auth?: { deployKey?: string; pat?: string } },
    repo,
    args,
    opts,
  );
}

function runLocalGit(
  access: { mode: "local-path" } | { mode: RepoAccessMode },
  repo: RepoLike,
  args: string[],
  opts: RunGitOptions,
): GitResult {
  if (!repo.path) {
    throw new Error("internal: local-path mode without repo.path");
  }
  try {
    const stdout = execFileSync("git", ["-C", repo.path, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: typeof err?.stdout === "string" ? err.stdout : "",
      stderr: typeof err?.stderr === "string" ? err.stderr : err?.message ?? "",
      exitCode: typeof err?.status === "number" ? err.status : -1,
    };
  }
}

async function runVolumeGit(
  access:
    | { mode: "remote-volume"; volumeName: string; auth?: { deployKey?: string; pat?: string } }
    | { mode: RepoAccessMode; volumeName?: string; auth?: { deployKey?: string; pat?: string } },
  repo: RepoLike,
  args: string[],
  opts: RunGitOptions,
): Promise<GitResult> {
  if (!access.volumeName || !repo.cloneUrl) {
    throw new Error("internal: remote-volume mode without volume/cloneUrl");
  }

  if (opts.commitHash) {
    await gitService.syncToCommit({
      repoId: repo.id,
      volumeName: access.volumeName,
      cloneUrl: repo.cloneUrl,
      commitHash: opts.commitHash,
      deployKey: access.auth?.deployKey,
      pat: access.auth?.pat,
    });
  }

  const shellScript = `git ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const orchestrator = ContainerOrchestrator.getInstance();
  const result = await orchestrator.runRunner({
    volumeName: access.volumeName,
    image: process.env.DRAGNET_GIT_IMAGE ?? "alpine/git",
    commands: [shellScript],
    networkMode: opts.networkMode ?? "none",
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}