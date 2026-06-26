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
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch {
    return false;
  }
}

export async function findRepoByCloneUrl(cloneUrl: string): Promise<{ id: string; localPath: string | null; webhookSecret: string | null } | null> {
  // DB-only match. Previously this function fell back to spawning a git
  // subprocess per repo for any repo without a stored cloneUrl — that
  // turned an unauthenticated webhook POST into N×5s of work BEFORE the
  // signature check ran (DoS amplification). Local-only repos (no stored
  // cloneUrl) don't receive webhooks anyway — they have no public endpoint
  // to be reached from. Drop the subprocess fallback.
  const repos = await prisma.repository.findMany({
    select: { id: true, path: true, localPath: true, cloneUrl: true, webhookSecret: true },
    where: { cloneUrl: { not: null } },
  });
  const normalizedClone = cloneUrl.replace(/\.git$/, "");

  for (const repo of repos) {
    if (!repo.cloneUrl) continue;
    if (repo.cloneUrl === cloneUrl || repo.cloneUrl.replace(/\.git$/, "") === normalizedClone) {
      return { id: repo.id, localPath: repo.localPath || repo.path, webhookSecret: repo.webhookSecret };
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
