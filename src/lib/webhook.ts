import { execFileSync } from "child_process";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";

const recentDeliveries = new Map<string, number>();
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentDeliveries) {
    if (now - ts > REPLAY_WINDOW_MS) recentDeliveries.delete(key);
  }
}, 60_000).unref();

/**
 * Track a delivery GUID for replay attack prevention. Returns true if the
 * GUID has not been seen within the replay window, false if it's a replay.
 * Periodically prunes entries older than 5 minutes.
 */
export function verifyReplayAttack(deliveryGuid: string): boolean {
  if (!deliveryGuid) return false;
  const now = Date.now();
  if (recentDeliveries.has(deliveryGuid)) return false;
  recentDeliveries.set(deliveryGuid, now);
  return true;
}

/** Exported for test cleanup only — resets the in-memory delivery GUID cache. */
export function resetRecentDeliveries(): void {
  recentDeliveries.clear();
}

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

export async function findRepoByCloneUrl(cloneUrl: string): Promise<{ id: string; localPath: string | null; webhookSecret: string | null; webhookEnabled: boolean } | null> {
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

  const select = { id: true, path: true, localPath: true, cloneUrl: true, webhookSecret: true, webhookEnabled: true } as const;

  const exact = await prisma.repository.findFirst({
    select,
    where: { cloneUrl },
  });
  if (exact) {
    return { id: exact.id, localPath: exact.localPath || exact.path, webhookSecret: exact.webhookSecret, webhookEnabled: exact.webhookEnabled };
  }

  if (normalizedClone !== cloneUrl) {
    const stripped = await prisma.repository.findFirst({
      select,
      where: { cloneUrl: normalizedClone },
    });
    if (stripped) {
      return { id: stripped.id, localPath: stripped.localPath || stripped.path, webhookSecret: stripped.webhookSecret, webhookEnabled: stripped.webhookEnabled };
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

export async function scanRepoPrs(repoId: string, repoPath: string, branchName?: string) {
  try {
    const { getRealLocalPrs } = await import("./getRealLocalPrs");
    await getRealLocalPrs(repoPath, repoId, branchName ? [branchName] : undefined);
  } catch (err) {
    console.error(`PR scan failed for ${repoId}:`, err);
  }
}
