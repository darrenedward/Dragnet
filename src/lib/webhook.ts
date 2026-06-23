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

export function getRepoRemoteUrl(repoPath: string): string {
  try {
    return execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

export async function findRepoByCloneUrl(cloneUrl: string): Promise<{ id: string; localPath: string | null; webhookSecret: string | null } | null> {
  const repos = await prisma.repository.findMany({
    select: { id: true, path: true, localPath: true, cloneUrl: true, webhookSecret: true },
  });
  const normalizedClone = cloneUrl.replace(/\.git$/, "");

  for (const repo of repos) {
    if (repo.cloneUrl) {
      if (repo.cloneUrl === cloneUrl || repo.cloneUrl.replace(/\.git$/, "") === normalizedClone) {
        return { id: repo.id, localPath: repo.localPath || repo.path, webhookSecret: repo.webhookSecret };
      }
      continue;
    }
    if (!repo.path) continue;
    const remoteUrl = getRepoRemoteUrl(repo.path);
    if (!remoteUrl) continue;
    if (remoteUrl === cloneUrl) return { id: repo.id, localPath: repo.path, webhookSecret: repo.webhookSecret };
    if (remoteUrl.replace(/\.git$/, "") === normalizedClone) return { id: repo.id, localPath: repo.path, webhookSecret: repo.webhookSecret };
    const sshToHttps = remoteUrl.replace(/^git@[^:]+:/, "https://github.com/").replace(/\.git$/, "");
    if (sshToHttps === normalizedClone) return { id: repo.id, localPath: repo.path, webhookSecret: repo.webhookSecret };
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
