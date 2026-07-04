/**
 * PR Polling Worker — polls GitHub for new commits on open PRs.
 *
 * Used when Dragnet runs behind a firewall or on a local machine where
 * Git webhooks cannot reach the server. For each remote repo with
 * `isPollingEnabled = true`, we query the GitHub API for all open PRs
 * targeting the repo's baseBranch and compare the head commit SHA
 * against what's stored in `pull_requests.commitHash`. If it changed,
 * we update the record and trigger a review scan.
 *
 * Rate limiting:
 *   - One polling cycle at a time; the timer fires every POLL_INTERVAL_MS.
 *   - Uses `If-None-Match` / ETag caching per repo to minimise API quota.
 *   - Default interval: 60 s (override: DRAGNET_POLL_INTERVAL_MS env var).
 *
 * Platform support: GitHub only in v1. GitLab stub returns early.
 */

import { prisma } from "./prisma";

export type TriggerScan = (
  repoId: string,
  prId: string,
  commitHash: string,
) => Promise<void>;

let pollingTimer: ReturnType<typeof setInterval> | null = null;

/** ETag cache keyed by `repoId` for the /pulls list endpoint. */
const etagCache = new Map<string, string>();

const POLL_INTERVAL_MS =
  Number(process.env.DRAGNET_POLL_INTERVAL_MS) || 60_000;

interface GhPullsEntry {
  number: number;
  head: { sha: string; ref: string };
  state: string;
}

/**
 * Poll all remote repos with `isPollingEnabled = true` and trigger scans
 * for PRs whose head commit has advanced since the last recorded hash.
 */
export async function pollOnce(triggerScan: TriggerScan): Promise<void> {
  let repos: Awaited<ReturnType<typeof fetchPollingRepos>>;
  try {
    repos = await fetchPollingRepos();
  } catch (err: any) {
    console.warn("[poll] DB query failed:", err.message);
    return;
  }

  for (const repo of repos) {
    if (repo.provider !== "github") continue; // GitLab: future work
    if (!repo.cloneUrlHttps) continue;

    const match = repo.cloneUrlHttps.match(
      /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    );
    if (!match) continue;
    const [, owner, repoName] = match;

    let pat: string | undefined;
    if (repo.patCipher && repo.patIv && repo.patTag) {
      try {
        const { decryptSecret } = await import("./crypto");
        pat = decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
      } catch {
        /* no master key — unauthenticated (60 req/hr limit) */
      }
    }

    // Fetch the list of open PRs from GitHub.
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "dragnet-poller/1.0",
    };
    if (pat) headers["Authorization"] = `Bearer ${pat}`;
    const etag = etagCache.get(repo.id);
    if (etag) headers["If-None-Match"] = etag;

    let ghPrs: GhPullsEntry[] = [];
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/pulls?state=open&per_page=100`,
        { headers },
      );
      if (res.status === 304) continue; // nothing changed
      if (!res.ok) {
        console.warn(
          `[poll] GitHub ${res.status} for ${owner}/${repoName}:`,
          await res.text().catch(() => ""),
        );
        continue;
      }
      const newEtag = res.headers.get("etag");
      if (newEtag) etagCache.set(repo.id, newEtag);
      ghPrs = (await res.json()) as GhPullsEntry[];
    } catch (err: any) {
      console.warn(`[poll] fetch error for ${repo.name}:`, err.message);
      continue;
    }

    // Match GitHub PRs to local DB records by sourceBranch.
    for (const ghPr of ghPrs) {
      const localPr = repo.pullRequests.find(
        (p) => p.sourceBranch === ghPr.head.ref,
      );
      if (!localPr) continue; // PR not yet registered in Dragnet
      if (ghPr.head.sha === localPr.commitHash) continue; // no change

      console.log(
        `[poll] ${repo.name} #${ghPr.number} (${ghPr.head.ref}) advanced ` +
          `${localPr.commitHash?.slice(0, 7)} → ${ghPr.head.sha.slice(0, 7)} — queuing scan`,
      );

      try {
        await prisma.pullRequest.update({
          where: { id: localPr.id },
          data: { commitHash: ghPr.head.sha },
        });
        await triggerScan(repo.id, localPr.id, ghPr.head.sha);
      } catch (err: any) {
        console.warn(
          `[poll] trigger failed for ${repo.name}/${localPr.id}:`,
          err.message,
        );
      }
    }
  }
}

async function fetchPollingRepos() {
  return prisma.repository.findMany({
    where: { isPollingEnabled: true },
    select: {
      id: true,
      name: true,
      provider: true,
      cloneUrlHttps: true,
      baseBranch: true,
      patCipher: true,
      patIv: true,
      patTag: true,
      pullRequests: {
        select: { id: true, sourceBranch: true, commitHash: true },
      },
    },
  });
}

/** Start the background polling loop. Idempotent. */
export function startPolling(triggerScan: TriggerScan): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(() => {
    pollOnce(triggerScan).catch((err) =>
      console.warn("[poll] unhandled error in pollOnce:", err),
    );
  }, POLL_INTERVAL_MS);
  console.log(`[poll] polling started (interval: ${POLL_INTERVAL_MS}ms)`);
}

/** Stop the background polling loop. Idempotent. */
export function stopPolling(): void {
  if (!pollingTimer) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
  console.log("[poll] polling stopped");
}
