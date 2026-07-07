import { execFileSync } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";
import { runGitInRepo, type RepoLike } from "./repoAccess";

export function verifyGithubSignature(payload: string, signature: string, secret: string): boolean {
  if (!secret || !signature) return false;
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  const expected = `sha256=${hmac.digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function verifyGitlabToken(token: string, secret: string): boolean {
  if (!token || !secret) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch {
    return false;
  }
}

/**
 * Find a repo by its clone URL. Returns the full row (not a summary)
 * so callers can dispatch git operations through `runGitInRepo` for
 * either local-path or remote-volume mode.
 */
export async function findRepoByCloneUrl(cloneUrl: string): Promise<{
  id: string;
  path: string | null;
  localPath: string | null;
  cloneUrl: string | null;
  cloneUrlHttps: string | null;
  webhookSecret: string | null;
  hostedMode: boolean;
  deployKeyCipher: string | null;
  deployKeyIv: string | null;
  deployKeyTag: string | null;
  patCipher: string | null;
  patIv: string | null;
  patTag: string | null;
} | null> {
  // DB-side match. Two prior DoS amplification bugs lived here:
  //   1. (removed) git subprocess per repo without a stored cloneUrl, paid
  //      BEFORE the signature check.
  //   2. (fixed here) findMany({ where: { cloneUrl: { not: null } } })
  //      loaded every repo row into memory and matched in JS — every
  //      unauthenticated webhook POST paid O(N) row serialization before
  //      HMAC verify. Now an indexed equality lookup returning 0-1 rows.
  //
  // We try the exact clone_url first (what GitHub sends), then the
  // .git-stripped form (some send git@...:foo/bar.git, others git@...:foo/bar).
  const normalizedClone = cloneUrl.replace(/\.git$/, "");

  const select = {
    id: true,
    path: true,
    localPath: true,
    cloneUrl: true,
    cloneUrlHttps: true,
    webhookSecret: true,
    hostedMode: true,
    deployKeyCipher: true,
    deployKeyIv: true,
    deployKeyTag: true,
    patCipher: true,
    patIv: true,
    patTag: true,
  } as const;

  const exact = await prisma.repository.findFirst({
    select,
    where: { cloneUrl },
  });
  if (exact) return exact;

  if (normalizedClone !== cloneUrl) {
    const stripped = await prisma.repository.findFirst({
      select,
      where: { cloneUrl: normalizedClone },
    });
    if (stripped) return stripped;
  }

  return null;
}

export async function getOpenPrIds(repoId: string): Promise<string[]> {
  const prs = await prisma.pullRequest.findMany({
    where: { repoId, status: "Open" },
    select: { id: true },
  });
  return prs.map((p) => p.id);
}

/**
 * Run `git fetch origin` against the repo. Legacy mode (local-path):
 * execFileSync directly. Remote-volume mode: spin up an alpine/git
 * sidecar with the named volume mounted. Returns true on success,
 * false on failure (webhook flow continues regardless).
 */
export async function gitFetch(repo: RepoLike): Promise<boolean> {
  const { exitCode } = await runGitInRepo(repo, ["fetch", "origin"], {
    networkMode: "bridge",
    timeoutMs: 60_000,
  });
  return exitCode === 0;
}

export async function scanRepoPrs(repo: RepoLike): Promise<string[]> {
  try {
    const { getRealLocalPrs } = await import("./getRealLocalPrs");
    const prs = await getRealLocalPrs(repo);
    return (prs ?? []).map((p: any) => p.id);
  } catch (err) {
    console.error(`PR scan failed for ${repo.id}:`, err);
    return [];
  }
}
