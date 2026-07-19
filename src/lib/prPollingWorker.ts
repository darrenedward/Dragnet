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

import { execFileSync } from "child_process";
import { prisma } from "./prisma";
import { statusForRevision } from "./prRevisionStatus";
import { isAutoRescanEnabled } from "./autoRescanPolicy";

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
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  base?: { ref?: string } | null;
  head: { sha: string; ref: string };
  state: string;
}

/**
 * Fetch the live target branch (baseRefName) from GitHub for a given PR
 * number using the `gh` CLI.  Returns null if `gh` is not installed, the
 * PR doesn't exist, or any other error occurs — callers must gracefully
 * skip rather than fail.
 */
export function fetchGhTargetBranch(prNumber: number): string | null {
  try {
    const output = execFileSync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "baseRefName"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, encoding: "utf8" },
    ).trim();
    const parsed: Record<string, unknown> = JSON.parse(output);
    return typeof parsed.baseRefName === "string" && parsed.baseRefName.length > 0
      ? parsed.baseRefName
      : null;
  } catch {
    return null;
  }
}

/** Internal type for the DB shape returned by fetchPollingRepos. */
interface LocalPrRow {
  id: string;
  githubPrNumber: number | null;
  sourceBranch: string;
  commitHash: string;
  targetBranch: string;
  status: string;
}

type LocalPrMatch =
  | { kind: "match"; pr: LocalPrRow }
  | { kind: "missing" }
  | { kind: "ambiguous" };

function matchLocalPr(
  localPrs: LocalPrRow[],
  githubPrNumber: number,
  sourceBranch: string,
): LocalPrMatch {
  const numberedMatches = localPrs.filter((pr) => pr.githubPrNumber === githubPrNumber);
  if (numberedMatches.length > 1) return { kind: "ambiguous" };
  if (numberedMatches.length === 1) return { kind: "match", pr: numberedMatches[0] };

  const branchMatches = localPrs.filter(
    (pr) => pr.githubPrNumber == null && pr.sourceBranch === sourceBranch,
  );
  if (branchMatches.length > 1) return { kind: "ambiguous" };
  if (branchMatches.length === 1) return { kind: "match", pr: branchMatches[0] };
  return { kind: "missing" };
}

async function admitRevision(
  triggerScan: TriggerScan,
  repoId: string,
  prId: string,
  commitHash: string,
): Promise<void> {
  await triggerScan(repoId, prId, commitHash);
}

async function admissionNeeded(
  repoId: string,
  prId: string,
  commitHash: string,
): Promise<boolean> {
  const scanJob = (prisma as typeof prisma & {
    scanJob?: { findUnique: (args: unknown) => Promise<unknown> };
  }).scanJob;
  if (!scanJob) return false;
  try {
    const job = await scanJob.findUnique({
      where: { prId_commitHash: { prId, commitHash } },
      select: { id: true },
    });
    return !job;
  } catch {
    return false;
  }
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
      const targetBranch = ghPr.base?.ref ?? repo.baseBranch;
      if (targetBranch !== repo.baseBranch) continue;

      const matchResult = matchLocalPr(repo.pullRequests as LocalPrRow[], ghPr.number, ghPr.head.ref);
      if (matchResult.kind === "ambiguous") {
        console.warn(
          `[poll] ambiguous local PR match for ${repo.name}/#${ghPr.number} on branch ${ghPr.head.ref}; skipping`,
        );
        continue;
      }
      const localPr = matchResult.kind === "match" ? matchResult.pr : undefined;

      if (!localPr) {
        const prId = `poll-pr-${repo.id}-${ghPr.number}`;
        try {
          await prisma.pullRequest.create({
            data: {
              id: prId,
              repoId: repo.id,
              githubPrNumber: ghPr.number,
              title: ghPr.title ?? `PR #${ghPr.number}`,
              sourceBranch: ghPr.head.ref,
              targetBranch: ghPr.base?.ref ?? repo.baseBranch,
              status: "Pending",
              author: ghPr.user?.login ?? "GitHub",
              commitHash: ghPr.head.sha,
              createdAt: ghPr.created_at ?? new Date().toISOString(),
              description: ghPr.body ?? null,
            },
          });
          if (isAutoRescanEnabled(repo.autoRescanPolicy)) {
            await admitRevision(triggerScan, repo.id, prId, ghPr.head.sha);
          }
        } catch (err: any) {
          console.warn(`[poll] registration failed for ${repo.name}/#${ghPr.number}:`, err.message);
        }
        continue;
      }

      // ── Sync targetBranch from GitHub (stale in stacked-PR workflows) ──
      const liveTargetBranch = ghPr.base?.ref ?? fetchGhTargetBranch(ghPr.number);
      if (liveTargetBranch && liveTargetBranch !== localPr.targetBranch) {
        console.log(
          `[poll] ${repo.name} #${ghPr.number} targetBranch changed: ` +
            `${localPr.targetBranch} → ${liveTargetBranch}`,
        );
        try {
          await prisma.pullRequest.update({
            where: { id: localPr.id },
            data: { targetBranch: liveTargetBranch },
          });
        } catch (err: any) {
          console.warn(
            `[poll] targetBranch update failed for ${repo.name}/${localPr.id}:`,
            err.message,
          );
        }
      }

      if (ghPr.head.sha === localPr.commitHash) {
        if (!(await admissionNeeded(repo.id, localPr.id, ghPr.head.sha))) continue;
        if (!isAutoRescanEnabled(repo.autoRescanPolicy)) {
          continue;
        }
        try {
          await admitRevision(triggerScan, repo.id, localPr.id, ghPr.head.sha);
        } catch (err: any) {
          console.warn(
            `[poll] retry admission failed for ${repo.name}/${localPr.id}:`,
            err.message,
          );
        }
        continue;
      }

      console.log(
        `[poll] ${repo.name} #${ghPr.number} (${ghPr.head.ref}) advanced ` +
          `${localPr.commitHash?.slice(0, 7)} → ${ghPr.head.sha.slice(0, 7)} — queuing scan`,
      );

      try {
        await prisma.pullRequest.update({
          where: { id: localPr.id },
          data: {
            commitHash: ghPr.head.sha,
            status: statusForRevision(localPr.status, localPr.commitHash, ghPr.head.sha),
          },
        });
        if (isAutoRescanEnabled(repo.autoRescanPolicy)) {
          await admitRevision(triggerScan, repo.id, localPr.id, ghPr.head.sha);
        }
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
      autoRescanPolicy: true,
      pullRequests: {
        select: {
          id: true,
          githubPrNumber: true,
          sourceBranch: true,
          commitHash: true,
          targetBranch: true,
          status: true,
        },
      },
    },
  });
}

/** Start the background polling loop. Idempotent. */
export function startPolling(triggerScan: TriggerScan): void {
  if (pollingTimer) return;
  let pollingInFlight = false;
  pollingTimer = setInterval(() => {
    if (pollingInFlight) return;
    pollingInFlight = true;
    void pollOnce(triggerScan)
      .catch((err) => console.warn("[poll] unhandled error in pollOnce:", err))
      .finally(() => {
        pollingInFlight = false;
      });
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
