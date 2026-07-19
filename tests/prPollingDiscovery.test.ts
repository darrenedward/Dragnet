import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type PrRow = {
  id: string;
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
  defaultEnabled: true,
}));
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: vi.fn().mockImplementation(() =>
        mockState.repo?.isPollingEnabled ? [mockState.repo] : [],
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
      mockState.repo!.pullRequests.push({ ...data });
      return data;
    });
    mockUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<PrRow> }) => {
      const existing = mockState.repo!.pullRequests.find((pr) => pr.id === where.id);
      if (existing) Object.assign(existing, data);
      return existing;
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
});
