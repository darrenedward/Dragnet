import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmdirSync, chmodSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const REPOS_SUBDIR = ".repos";

function cloneDir(): string {
  return process.env.REPOS_DIR || path.join(process.cwd(), REPOS_SUBDIR);
}

export interface CloneOpts {
  repoId: string;
  cloneUrl: string;
  deployKey?: string;
  pat?: string;
  installationToken?: string;
}

export interface FetchOpts {
  localPath: string;
  cloneUrl: string;
  deployKey?: string;
  pat?: string;
  installationToken?: string;
}

export function cloneRepo(opts: CloneOpts): string {
  const root = cloneDir();
  const dest = path.join(root, opts.repoId);
  mkdirSync(root, { recursive: true });

  const effectivePat = opts.installationToken || opts.pat;
  const url = interpolatePat(opts.cloneUrl, effectivePat);
  using ssh = opts.deployKey
    ? buildSshEnv(opts.deployKey, `clone-${opts.repoId}`)
    : { env: undefined as Record<string, string> | undefined, [Symbol.dispose]() {} };

  execFileSync("git", ["clone", "--filter=blob:none", url, dest], {
    env: { ...process.env, ...ssh.env },
    stdio: "pipe",
    timeout: 300_000,
  });

  return dest;
}

export function fetchRepo(opts: FetchOpts): void {
  const effectivePat = opts.installationToken || opts.pat;
  const url = interpolatePat(opts.cloneUrl, effectivePat);
  using ssh = opts.deployKey
    ? buildSshEnv(opts.deployKey, `fetch-${crypto.randomUUID().slice(0, 8)}`)
    : { env: undefined as Record<string, string> | undefined, [Symbol.dispose]() {} };

  execFileSync("git", ["fetch", "origin", "--prune"], {
    cwd: opts.localPath,
    env: { ...process.env, ...ssh.env },
    stdio: "pipe",
    timeout: 120_000,
  });
}

export function buildSshEnv(
  deployKey: string,
  keyId: string,
): { env: Record<string, string>; [Symbol.dispose](): void } {
  const baseTmp = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  // mkdtempSync gives a private, unpredictable directory. Earlier versions
  // used a fixed name `dragnet-deploykey-${keyId}` directly in /tmp —
  // predictable path + 0o600 file still left the key readable if an attacker
  // won the race between writeFileSync and chmod, or if the cleanup
  // unlinkSync was skipped (process crash). Private 0o700 dir + readonly
  // cleanup of both file and directory closes that.
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

function interpolatePat(cloneUrl: string, pat?: string): string {
  if (!pat) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    if (u.protocol !== "https:") {
      console.warn(`[gitRemote] PAT only works with HTTPS URLs, got protocol "${u.protocol}" for "${cloneUrl}" — PAT ignored`);
      return cloneUrl;
    }
    u.username = "x-access-token";
    u.password = pat;
    return u.toString();
  } catch {
    console.warn(`[gitRemote] Failed to parse cloneUrl for PAT injection — "${cloneUrl}" is not a valid URL (SSH?); PAT ignored`);
    return cloneUrl;
  }
}
