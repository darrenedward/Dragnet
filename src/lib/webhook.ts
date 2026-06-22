import { execSync } from "child_process";
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

export function getRepoRemoteUrl(repoPath: string): string {
  try {
    return execSync(`git -C "${repoPath}" remote get-url origin`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

export async function findRepoByCloneUrl(cloneUrl: string): Promise<{ id: string; path: string } | null> {
  const repos = await prisma.repository.findMany({ select: { id: true, path: true } });
  const normalizedClone = cloneUrl.replace(/\.git$/, "");
  for (const repo of repos) {
    const remoteUrl = getRepoRemoteUrl(repo.path);
    if (!remoteUrl) continue;
    if (remoteUrl === cloneUrl) return repo;
    if (remoteUrl.replace(/\.git$/, "") === normalizedClone) return repo;
    const sshToHttps = remoteUrl.replace(/^git@[^:]+:/, "https://github.com/").replace(/\.git$/, "");
    if (sshToHttps === normalizedClone) return repo;
  }
  return null;
}

export function gitFetch(repoPath: string): boolean {
  try {
    execSync(`git -C "${repoPath}" fetch origin 2>&1`, { encoding: "utf8", timeout: 30000 });
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
