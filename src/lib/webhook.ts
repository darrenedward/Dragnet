import { execFileSync } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";

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
  // Use HMAC/SHA-256 to hash both before comparison to prevent length-leaking
  // timing attacks (timingSafeEqual throws if lengths differ). GitLab sends
  // the token as a plaintext header, unlike GitHub's HMAC signature.
  const tokenHash = createHmac("sha256", secret).update(token).digest();
  const secretHash = createHmac("sha256", secret).update(secret).digest();
  try {
    return timingSafeEqual(tokenHash, secretHash);
  } catch {
    return false;
  }
}

export async function findRepoByCloneUrl(cloneUrl: string): Promise<{ id: string; localPath: string | null; webhookSecret: string | null } | null> {
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

  const select = { id: true, path: true, localPath: true, cloneUrl: true, webhookSecret: true } as const;

  const exact = await prisma.repository.findFirst({
    select,
    where: { cloneUrl },
  });
  if (exact) {
    return { id: exact.id, localPath: exact.localPath || exact.path, webhookSecret: exact.webhookSecret };
  }

  if (normalizedClone !== cloneUrl) {
    const stripped = await prisma.repository.findFirst({
      select,
      where: { cloneUrl: normalizedClone },
    });
    if (stripped) {
      return { id: stripped.id, localPath: stripped.localPath || stripped.path, webhookSecret: stripped.webhookSecret };
    }
  }

  return null;
}

export function gitFetch(repoPath: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "fetch", "origin"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function scanRepoPrs(repoId: string, repoPath: string) {
  try {
    const { getRealLocalPrs } = await import("./getRealLocalPrs");
    await getRealLocalPrs(repoPath, repoId);
  } catch (err) {
    console.error(`PR scan failed for ${repoId}:`, err);
  }
}
