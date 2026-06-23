import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REPOS_SUBDIR = ".repos";

function cloneDir(): string {
  return process.env.REPOS_DIR || path.join(process.cwd(), REPOS_SUBDIR);
}

export interface CloneOpts {
  repoId: string;
  cloneUrl: string;
  deployKey?: string;
  pat?: string;
}

export interface FetchOpts {
  localPath: string;
  cloneUrl: string;
  deployKey?: string;
  pat?: string;
}

export function cloneRepo(opts: CloneOpts): string {
  const root = cloneDir();
  const dest = path.join(root, opts.repoId);
  mkdirSync(root, { recursive: true });

  const url = interpolatePat(opts.cloneUrl, opts.pat);
  const { env, cleanup } = opts.deployKey
    ? buildSshEnv(opts.deployKey, `clone-${opts.repoId}`)
    : { env: undefined as Record<string, string> | undefined, cleanup: () => {} };

  try {
    execFileSync("git", ["clone", "--filter=blob:none", url, dest], {
      env: { ...process.env, ...env },
      stdio: "pipe",
      timeout: 300_000,
    });
  } finally {
    cleanup();
  }

  return dest;
}

export function fetchRepo(opts: FetchOpts): void {
  const url = interpolatePat(opts.cloneUrl, opts.pat);
  const { env, cleanup } = opts.deployKey
    ? buildSshEnv(opts.deployKey, `fetch-${crypto.randomUUID().slice(0, 8)}`)
    : { env: undefined as Record<string, string> | undefined, cleanup: () => {} };

  try {
    execFileSync("git", ["fetch", "origin", "--prune"], {
      cwd: opts.localPath,
      env: { ...process.env, ...env },
      stdio: "pipe",
      timeout: 120_000,
    });
  } finally {
    cleanup();
  }
}

export function buildSshEnv(
  deployKey: string,
  keyId: string,
): { env: Record<string, string>; cleanup: () => void } {
  const tmpDir = process.env.XDG_RUNTIME_DIR || "/tmp";
  const keyFile = path.join(tmpDir, `greploop-deploykey-${keyId}`);
  writeFileSync(keyFile, deployKey, { mode: 0o600 });
  return {
    env: {
      GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`,
    },
    cleanup: () => {
      try {
        unlinkSync(keyFile);
      } catch {
        /* best-effort */
      }
    },
  };
}

function interpolatePat(cloneUrl: string, pat?: string): string {
  if (!pat) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.username = "x-access-token";
    u.password = pat;
    return u.toString();
  } catch {
    return cloneUrl;
  }
}
