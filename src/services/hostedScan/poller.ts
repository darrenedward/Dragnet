import { prisma } from "@/src/lib/prisma";
import { triggerHostedScan } from "./orchestrator";
import type { HostedPrData } from "./orchestrator";

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingInFlight = false;
const etagCache = new Map<string, string>();

const POLL_INTERVAL_MS =
  Number(process.env.DRAGNET_HOSTED_POLL_INTERVAL_MS) || 60_000;

interface PollResult {
  total: number;
  synced: number;
  scanned: number;
  errors: string[];
}

interface HostedRepoRow {
  id: string;
  name: string;
  provider: string | null;
  cloneUrlHttps: string | null;
  cloneUrl: string | null;
  baseBranch: string;
  branchPattern: string;
  patCipher: string | null;
  patIv: string | null;
  patTag: string | null;
}

interface NormalizedPrItem {
  prNumber: number;
  title: string;
  headBranch: string;
  baseBranch: string;
  commitHash: string;
  author: string;
  description: string | undefined;
}

interface ProviderAdapter {
  fetchPrs(repo: HostedRepoRow, pat: string | undefined): Promise<NormalizedPrItem[] | null>;
}

function parseOwnerRepo(cloneUrl: string): { owner: string; repo: string } | null {
  const m = cloneUrl.match(
    /(?:git@|https?:\/\/)[^:/]+[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/,
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function getPat(repo: HostedRepoRow): Promise<string | undefined> {
  if (repo.patCipher && repo.patIv && repo.patTag) {
    try {
      const { decryptSecret } = await import("@/src/lib/crypto");
      return decryptSecret(repo.patCipher, repo.patIv, repo.patTag);
    } catch {
      /* no master key — rate limited */
    }
  }
  return undefined;
}

function matchBranchPattern(branch: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true;
  const regexSafe = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regexSafe}$`).test(branch);
}

const githubAdapter: ProviderAdapter = {
  async fetchPrs(repo, pat) {
    const cloneUrl = repo.cloneUrlHttps || repo.cloneUrl;
    if (!cloneUrl) return [];

    const parsed = parseOwnerRepo(cloneUrl);
    if (!parsed) {
      console.warn(`[hosted-poller] cannot parse GitHub clone URL for ${repo.name}`);
      return [];
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "dragnet-hosted-poller/1.0",
    };
    if (pat) headers["Authorization"] = `Bearer ${pat}`;
    const etag = etagCache.get(repo.id);
    if (etag) headers["If-None-Match"] = etag;

    const res = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls?state=open&per_page=100`,
      { headers },
    );

    if (res.status === 304) return null;
    if (!res.ok) {
      console.warn(
        `[hosted-poller] GitHub ${res.status} for ${repo.name}:`,
        await res.text().catch(() => ""),
      );
      return [];
    }
    const newEtag = res.headers.get("etag");
    if (newEtag) etagCache.set(repo.id, newEtag);

    const raw = (await res.json()) as {
      number: number; title: string; head: { sha: string; ref: string };
      base: { ref: string }; user: { login: string } | null; body: string | null;
    }[];

    return raw.map((pr) => ({
      prNumber: pr.number,
      title: pr.title || "Untitled",
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      commitHash: pr.head.sha,
      author: pr.user?.login || "poller",
      description: pr.body || undefined,
    }));
  },
};

const gitlabAdapter: ProviderAdapter = {
  async fetchPrs(repo, pat) {
    const cloneUrl = repo.cloneUrlHttps || repo.cloneUrl;
    if (!cloneUrl) return [];

    const parsed = parseOwnerRepo(cloneUrl);
    if (!parsed) return [];

    const encoded = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
    const headers: Record<string, string> = {
      "User-Agent": "dragnet-hosted-poller/1.0",
    };
    if (pat) headers["PRIVATE-TOKEN"] = pat;
    const etag = etagCache.get(repo.id);
    if (etag) headers["If-None-Match"] = etag;

    const res = await fetch(
      `https://gitlab.com/api/v4/projects/${encoded}/merge_requests?state=opened&per_page=100`,
      { headers },
    );

    if (res.status === 304) return null;
    if (!res.ok) {
      console.warn(
        `[hosted-poller] GitLab ${res.status} for ${repo.name}:`,
        await res.text().catch(() => ""),
      );
      return [];
    }
    const newEtag = res.headers.get("etag");
    if (newEtag) etagCache.set(repo.id, newEtag);

    const raw = (await res.json()) as {
      iid: number; title: string; source_branch: string;
      target_branch: string; sha: string;
      author: { username: string } | null; description: string | null;
    }[];

    return raw.map((mr) => ({
      prNumber: mr.iid,
      title: mr.title || "Untitled",
      headBranch: mr.source_branch,
      baseBranch: mr.target_branch,
      commitHash: mr.sha,
      author: mr.author?.username || "poller",
      description: mr.description || undefined,
    }));
  },
};

const adapters: Record<string, ProviderAdapter | undefined> = {
  github: githubAdapter,
  gitlab: gitlabAdapter,
};

async function syncPr(
  repoId: string,
  item: NormalizedPrItem,
): Promise<{ synced: boolean; scanned: boolean }> {
  const prData: HostedPrData = {
    prNumber: item.prNumber,
    title: item.title,
    headBranch: item.headBranch,
    baseBranch: item.baseBranch,
    commitHash: item.commitHash,
    author: item.author,
    description: item.description,
  };

  const existing = await prisma.pullRequest.findFirst({
    where: { repoId, sourceBranch: item.headBranch, targetBranch: item.baseBranch },
    orderBy: { createdAt: "desc" },
    select: { id: true, commitHash: true },
  });

  const isNew = !existing;
  const isUpdated = existing && existing.commitHash !== item.commitHash;
  const needsScan = isNew || isUpdated;

  if (needsScan) {
    const res = await triggerHostedScan(repoId, prData, {
      automatic: true,
      triggerReason: "polling",
    });
    if (!res.ok) {
      throw new Error(`triggerHostedScan failed: ${(res as { error: string }).error}`);
    }
  }

  return { synced: true, scanned: needsScan };
}

export async function pollHostedRepos(): Promise<PollResult> {
  const result: PollResult = { total: 0, synced: 0, scanned: 0, errors: [] };

  let repos: HostedRepoRow[];
  try {
    repos = await prisma.repository.findMany({
      where: { hostedMode: true, isPollingEnabled: true },
      select: {
        id: true,
        name: true,
        provider: true,
        cloneUrlHttps: true,
        cloneUrl: true,
        baseBranch: true,
        branchPattern: true,
        patCipher: true,
        patIv: true,
        patTag: true,
      },
    });
  } catch (err: any) {
    console.warn("[hosted-poller] DB query failed:", err.message);
    return result;
  }

  for (const repo of repos) {
    result.total++;

    const adapter = repo.provider ? adapters[repo.provider] : undefined;
    if (!adapter) {
      console.warn(`[hosted-poller] unsupported provider for ${repo.name}: ${repo.provider}`);
      continue;
    }

    const pat = await getPat(repo);

    try {
      const items = await adapter.fetchPrs(repo, pat);
      if (items === null) continue;

      for (const item of items) {
        if (item.baseBranch !== repo.baseBranch) continue;
        if (!matchBranchPattern(item.headBranch, repo.branchPattern)) continue;

        const proc = await syncPr(repo.id, item);
        if (proc.synced) result.synced++;
        if (proc.scanned) result.scanned++;
      }
    } catch (err: any) {
      result.errors.push(`${repo.name}: ${err.message}`);
      console.warn(`[hosted-poller] error processing ${repo.name}:`, err.message);
    }
  }

  return result;
}

export function startHostedPoller(): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(() => {
    if (pollingInFlight) return;
    pollingInFlight = true;
    void pollHostedRepos()
      .catch((err) => console.warn("[hosted-poller] unhandled error:", err))
      .finally(() => {
        pollingInFlight = false;
      });
  }, POLL_INTERVAL_MS);
  console.log(`[hosted-poller] polling started (interval: ${POLL_INTERVAL_MS}ms)`);
}

export function stopHostedPoller(): void {
  if (!pollingTimer) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
  console.log("[hosted-poller] polling stopped");
}
