import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type PrRow = {
  id: string;
  repoId?: string;
  githubPrNumber?: number;
  sourceBranch: string;
  commitHash: string;
  status: string;
  targetBranch: string;
  title?: string;
  author?: string;
  description?: string | null;
  createdAt?: string;
};

type RepoRow = {
  id: string;
  name: string;
  provider: string;
  cloneUrlHttps: string;
  baseBranch: string;
  patCipher: string | null;
  patIv: string | null;
  patTag: string | null;
  autoRescanPolicy: string;
  isPollingEnabled: boolean;
  pullRequests: PrRow[];
};

const mockState = vi.hoisted(() => ({
  repo: null as RepoRow | null,
  additionalRepos: [] as RepoRow[],
  defaultEnabled: true,
  queueJobs: new Set<string>(),
}));
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: vi.fn().mockImplementation(() =>
        [mockState.repo, ...mockState.additionalRepos].filter(
          (repo): repo is RepoRow => Boolean(repo?.isPollingEnabled),
        ),
      ),
    },
    pullRequest: { create: mockCreate, update: mockUpdate },
  },
}));

vi.mock("../src/lib/autoRescanPolicy", () => ({
  isAutoRescanEnabled: (override: string) =>
    override === "enabled" || (override === "inherit" && mockState.defaultEnabled),
}));

import { pollOnce } from "../src/lib/prPollingWorker";

function response(prs: Array<{
  number: number;
  ref: string;
  sha: string;
  title?: string;
  body?: string | null;
  author?: string;
  baseRef?: string;
}>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Map([ ["etag", '"discovery"'] ]) as unknown as Headers,
    json: async () => prs.map((pr) => ({
      number: pr.number,
      title: pr.title ?? `PR #${pr.number}`,
      body: pr.body ?? null,
      user: { login: pr.author ?? "octocat" },
      created_at: "2026-07-19T00:00:00Z",
      base: { ref: pr.baseRef ?? "main" },
      head: { sha: pr.sha, ref: pr.ref },
      state: "open",
    })),
    text: async () => "",
  } as Response;
}

describe("server polling PR discovery", () => {
  const triggerScan = vi.fn();
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.defaultEnabled = true;
    mockState.additionalRepos = [];
    mockState.queueJobs.clear();
    mockState.repo = {
      id: "repo-discovery",
      name: "discovery-repo",
      provider: "github",
      cloneUrlHttps: "https://github.com/owner/discovery-repo.git",
      baseBranch: "main",
      patCipher: null,
      patIv: null,
      patTag: null,
      autoRescanPolicy: "inherit",
      isPollingEnabled: true,
      pullRequests: [],
    };
    mockCreate.mockImplementation(async ({ data }: { data: PrRow }) => {
      const repo = [mockState.repo, ...mockState.additionalRepos].find(
        (candidate) => candidate?.id === data.repoId,
      );
      repo?.pullRequests.push({ ...data });
      return data;
    });
    mockUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<PrRow> }) => {
      const existing = [mockState.repo, ...mockState.additionalRepos]
        .flatMap((repo) => repo?.pullRequests ?? [])
        .find((pr) => pr.id === where.id);
      if (existing) Object.assign(existing, data);
      return existing;
    });
    triggerScan.mockImplementation(async (repoId: string, prId: string, commitHash: string) => {
      mockState.queueJobs.add(`${repoId}:${prId}:${commitHash}`);
    });
  });

  afterEach(() => fetchSpy?.mockRestore());

  it("registers, ignores metadata-only changes, and requeues one changed revision", async () => {
    fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(response([{
        number: 7, ref: "feature/new", sha: "sha-1", title: "New PR",
        body: "Initial body", author: "alice", baseRef: "main",
      }]))
      .mockResolvedValueOnce(response([{
        number: 7, ref: "feature/new", sha: "sha-1", title: "Edited title",
        body: "Edited body", author: "bob", baseRef: "main",
      }]))
      .mockResolvedValueOnce(response([{
        number: 7, ref: "feature/new", sha: "sha-2", title: "Edited title",
        body: "Edited body", author: "bob", baseRef: "main",
      }]));

    await pollOnce(triggerScan);
    await pollOnce(triggerScan);
    await pollOnce(triggerScan);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: "poll-pr-repo-discovery-7",
      repoId: "repo-discovery",
      githubPrNumber: 7,
      title: "New PR",
      sourceBranch: "feature/new",
      targetBranch: "main",
      status: "Pending",
      author: "alice",
      commitHash: "sha-1",
      description: "Initial body",
    }) });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "poll-pr-repo-discovery-7" },
      data: { commitHash: "sha-2", status: "Pending" },
    });
    expect(triggerScan).toHaveBeenCalledTimes(2);
    expect(triggerScan).toHaveBeenNthCalledWith(1, "repo-discovery", "poll-pr-repo-discovery-7", "sha-1");
    expect(triggerScan).toHaveBeenNthCalledWith(2, "repo-discovery", "poll-pr-repo-discovery-7", "sha-2");
  });

  it("does not discover a repository with polling disabled", async () => {
    mockState.repo!.isPollingEnabled = false;
    fetchSpy = vi.spyOn(global, "fetch");

    await pollOnce(triggerScan);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(triggerScan).not.toHaveBeenCalled();
  });

  it("registers a pending PR without admission when policy disables auto-scan", async () => {
    mockState.repo!.autoRescanPolicy = "disabled";
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(response([{
      number: 8, ref: "manual-only", sha: "sha-manual",
    }]));

    await pollOnce(triggerScan);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "Pending" }) });
    expect(triggerScan).not.toHaveBeenCalled();
  });

  it("ignores open PRs targeting a branch other than the repository base", async () => {
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(response([
      { number: 14, ref: "release-fix", sha: "release-sha", baseRef: "release" },
      { number: 15, ref: "main-fix", sha: "main-sha", baseRef: "main" },
    ]));

    await pollOnce(triggerScan);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ githubPrNumber: 15, targetBranch: "main" }),
    });
    expect(triggerScan).toHaveBeenCalledTimes(1);
  });

  it("retries queue admission for an unchanged revision after a transient failure", async () => {
    fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(response([{ number: 16, ref: "retry", sha: "retry-sha" }]))
      .mockResolvedValueOnce(response([{ number: 16, ref: "retry", sha: "retry-sha" }]));
    triggerScan.mockRejectedValueOnce(new Error("queue unavailable"));

    await pollOnce(triggerScan);
    await pollOnce(triggerScan);

    expect(triggerScan).toHaveBeenCalledTimes(2);
    expect(triggerScan).toHaveBeenLastCalledWith(
      "repo-discovery",
      "poll-pr-repo-discovery-16",
      "retry-sha",
    );
  });

  it.each([
    ["inherit", true, true],
    ["inherit", false, false],
    ["enabled", true, true],
    ["enabled", false, true],
    ["disabled", true, false],
    ["disabled", false, false],
  ] as const)(
    "resolves %s against global default %s and admits only when enabled",
    async (policy, globalDefault, shouldQueue) => {
      mockState.repo!.autoRescanPolicy = policy;
      mockState.defaultEnabled = globalDefault;
      fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(response([
        { number: 9, ref: `policy-${policy}-${globalDefault}`, sha: "policy-sha" },
      ]));

      await pollOnce(triggerScan);

      expect(mockState.repo!.pullRequests[0].status).toBe("Pending");
      expect(mockState.queueJobs.size).toBe(shouldQueue ? 1 : 0);
    },
  );

  it("reuses the ETag and skips a 304 cycle without touching persisted state", async () => {
    mockState.repo!.id = "repo-etag-discovery";
    fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(response([{ number: 10, ref: "etagged", sha: "etag-sha" }]))
      .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers(), text: async () => "" } as Response);

    await pollOnce(triggerScan);
    const firstCreateCount = mockCreate.mock.calls.length;
    await pollOnce(triggerScan);

    expect(fetchSpy.mock.calls[1][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "If-None-Match": '"discovery"' }),
    }));
    expect(mockCreate).toHaveBeenCalledTimes(firstCreateCount);
    expect(triggerScan).toHaveBeenCalledTimes(1);
  });

  it("continues after one repository fails and retries it on the next cycle", async () => {
    const secondRepo = {
      ...mockState.repo!,
      id: "repo-second",
      name: "second-repo",
      cloneUrlHttps: "https://github.com/owner/second-repo.git",
      pullRequests: [],
    };
    mockState.additionalRepos = [secondRepo];
    fetchSpy = vi.spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("first repository unavailable"))
      .mockResolvedValueOnce(response([{ number: 11, ref: "second", sha: "second-sha" }]))
      .mockResolvedValueOnce(response([{ number: 12, ref: "recovered", sha: "recovered-sha" }]))
      .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers(), text: async () => "" } as Response);

    await pollOnce(triggerScan);
    expect(secondRepo.pullRequests).toHaveLength(1);
    expect(mockState.queueJobs).toContain("repo-second:poll-pr-repo-second-11:second-sha");

    await pollOnce(triggerScan);
    expect(mockState.repo!.pullRequests).toHaveLength(1);
    expect(mockState.queueJobs).toContain("repo-discovery:poll-pr-repo-discovery-12:recovered-sha");
  });

  it("coalesces repeated admissions for one PR revision to one queue identity", async () => {
    fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(response([{ number: 13, ref: "once", sha: "same-sha" }]))
      .mockResolvedValueOnce(response([{ number: 13, ref: "once", sha: "same-sha" }]));

    await pollOnce(triggerScan);
    await pollOnce(triggerScan);

    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(triggerScan).toHaveBeenCalledWith(
      "repo-discovery",
      "poll-pr-repo-discovery-13",
      "same-sha",
    );
    expect(mockState.queueJobs).toEqual(new Set([
      "repo-discovery:poll-pr-repo-discovery-13:same-sha",
    ]));
  });
});
