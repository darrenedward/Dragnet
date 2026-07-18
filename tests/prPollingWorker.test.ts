import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type PrRow = {
  id: string;
  sourceBranch: string;
  commitHash: string;
  status: string;
  targetBranch?: string;
};

type RepoRow = {
  id: string;
  name: string;
  provider: string;
  cloneUrlHttps: string | null;
  baseBranch: string;
  patCipher: string | null;
  patIv: string | null;
  patTag: string | null;
  pullRequests: PrRow[];
};

type PrismaFindManyArgs = {
  where: { isPollingEnabled: boolean };
  select: {
    pullRequests: {
      where?: { status?: { in: string[] } };
    };
  };
};

const mockExecFileSync = vi.hoisted(() => vi.fn<(...args: any[]) => string>());

vi.mock("child_process", () => ({
  execFileSync: mockExecFileSync,
}));

const mockState = vi.hoisted(() => ({
  dbFixtures: [] as RepoRow[],
  dbShouldThrow: null as string | null,
  autoRescanEnabled: true,
}));

vi.mock("../src/lib/prisma", () => {
  const pullRequestUpdate = vi.fn().mockResolvedValue({});
  return {
    prisma: {
      repository: {
        findMany: vi.fn().mockImplementation((args: PrismaFindManyArgs) => {
          if (mockState.dbShouldThrow) {
            throw new Error(mockState.dbShouldThrow);
          }
          const statusFilter = args.select?.pullRequests?.where?.status?.in;
          return mockState.dbFixtures.map((r) => ({
            ...r,
            pullRequests: statusFilter
              ? r.pullRequests.filter((pr) =>
                  statusFilter.includes(pr.status),
                )
              : r.pullRequests,
          }));
        }),
      },
      pullRequest: {
        update: pullRequestUpdate,
      },
    },
  };
});

vi.mock("../src/lib/autoRescanPolicy", () => ({
  isAutoRescanEnabled: () => mockState.autoRescanEnabled,
}));

import { pollOnce, fetchGhTargetBranch } from "../src/lib/prPollingWorker";
import { prisma } from "../src/lib/prisma";

describe("pollOnce", () => {
  const baseRepo: Omit<RepoRow, "pullRequests"> = {
    id: "repo-1",
    name: "test-repo",
    provider: "github",
    cloneUrlHttps: "https://github.com/owner/test-repo.git",
    baseBranch: "main",
    patCipher: null,
    patIv: null,
    patTag: null,
  };

  const triggerScan = vi.fn();
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.dbFixtures = [];
    mockState.dbShouldThrow = null;
    mockState.autoRescanEnabled = true;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function repoWithPrs(
    overrides: Partial<RepoRow> & { pullRequests: Partial<PrRow>[] },
  ): RepoRow {
    return {
      ...baseRepo,
      ...overrides,
      pullRequests: overrides.pullRequests.map((pr) => ({
        id: "pr-1",
        sourceBranch: "feature",
        commitHash: "old-sha",
        status: "Pending",
        ...pr,
      })) as PrRow[],
    };
  }

  function ghResponse(
    prs: { number: number; ref: string; sha: string }[],
  ): Response {
    return {
      ok: true,
      status: 200,
      headers: new Map([["etag", '"abc123"']]) as unknown as Headers,
      json: async () =>
        prs.map((p) => ({
          number: p.number,
          head: { sha: p.sha, ref: p.ref },
          state: "open",
        })),
      text: async () => "",
      redirected: false,
      statusText: "OK",
      type: "basic" as ResponseType,
      url: "https://api.github.com/",
      clone: () => new Response(),
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
    } as Response;
  }

  // ─── Core regression test ──────────────────────────────────────────

  it("re-scans a Completed PR when a new commit is pushed on the same branch", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "old-sha", status: "Completed" },
        ],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "new-sha" }])));

    await pollOnce(triggerScan);

    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(triggerScan).toHaveBeenCalledWith("repo-1", "pr-1", "new-sha");
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { commitHash: "new-sha", status: "Pending" } }),
    );
  });

  // ─── No-change guard ───────────────────────────────────────────────

  it("does not re-scan if commit hash has not changed", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [{ id: "pr-1", sourceBranch: "feature", commitHash: "same-sha", status: "Pending" }],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "same-sha" }])));

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
  });

  it("marks the new revision Pending without triggering a job when auto-rescan is disabled", async () => {
    mockState.autoRescanEnabled = false;
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [{ id: "pr-1", sourceBranch: "feature", commitHash: "old-sha", status: "Completed" }],
      }),
    ];
    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "new-sha" }])));

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.pullRequest.update)).toHaveBeenCalledWith(
      expect.objectContaining({ data: { commitHash: "new-sha", status: "Pending" } }),
    );
  });

  // ─── Pending PR still works ────────────────────────────────────────

  it("re-scans a Pending PR when commit changes", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "old-sha", status: "Pending" },
        ],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "new-sha" }])));

    await pollOnce(triggerScan);

    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(triggerScan).toHaveBeenCalledWith("repo-1", "pr-1", "new-sha");
  });

  // ─── Unregistered branch ───────────────────────────────────────────

  it("skips PRs from GitHub that are not yet registered in Dragnet", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "existing-branch", commitHash: "sha", status: "Pending" },
        ],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([
            { number: 1, ref: "existing-branch", sha: "sha" },
            { number: 2, ref: "unregistered-branch", sha: "other-sha" },
          ]),
        ),
      );

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
  });

  // ─── Graceful error handling ───────────────────────────────────────

  it("handles DB query failure gracefully", async () => {
    mockState.dbShouldThrow = "DB down";
    fetchSpy = vi.spyOn(global, "fetch");

    await pollOnce(triggerScan);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips non-github providers", async () => {
    mockState.dbFixtures = [
      repoWithPrs({ provider: "gitlab", pullRequests: [] }),
    ];

    fetchSpy = vi.spyOn(global, "fetch");

    await pollOnce(triggerScan);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips repos without cloneUrlHttps", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        cloneUrlHttps: null,
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending" },
        ],
      }),
    ];

    fetchSpy = vi.spyOn(global, "fetch");

    await pollOnce(triggerScan);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles GitHub API 304 (not modified) by skipping", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [{ id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending" }],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: false, status: 304 } as Response),
      );

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
  });

  it("handles GitHub API error status gracefully", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [{ id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending" }],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        } as Response),
      );

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
  });

  it("handles fetch network error gracefully", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [{ id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending" }],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.reject(new Error("Network error")));

    await pollOnce(triggerScan);

    expect(triggerScan).not.toHaveBeenCalled();
  });

  // ─── Multi-repo cycle ──────────────────────────────────────────────

  it("processes multiple repos in a single cycle", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        id: "repo-1",
        cloneUrlHttps: "https://github.com/owner-a/repo-a.git",
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "old-sha", status: "Pending" },
        ],
      }),
      repoWithPrs({
        id: "repo-2",
        name: "other-repo",
        cloneUrlHttps: "https://github.com/owner-b/repo-b.git",
        pullRequests: [
          { id: "pr-2", sourceBranch: "fix", commitHash: "unchanged", status: "Pending" },
        ],
      }),
    ];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "new-sha" }])))
      .mockImplementationOnce(() => Promise.resolve(ghResponse([{ number: 1, ref: "fix", sha: "unchanged" }])));

    await pollOnce(triggerScan);

    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(triggerScan).toHaveBeenCalledWith("repo-1", "pr-1", "new-sha");
  });

  // ─── targetBranch sync ────────────────────────────────────────────

  it("updates targetBranch when gh returns a different value", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending", targetBranch: "main" },
        ],
      }),
    ];
    mockExecFileSync.mockReturnValue('{"baseRefName":"develop"}');

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "sha" }])),
      );

    await pollOnce(triggerScan);

    expect(prisma.pullRequest.update).toHaveBeenCalledWith({
      where: { id: "pr-1" },
      data: { targetBranch: "develop" },
    });
  });

  it("does not update targetBranch when value matches stored", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "sha", status: "Pending", targetBranch: "main" },
        ],
      }),
    ];
    mockExecFileSync.mockReturnValue('{"baseRefName":"main"}');

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "sha" }])),
      );

    await pollOnce(triggerScan);

    expect(prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it("skips targetBranch sync gracefully when gh CLI is unavailable but still processes commit advance", async () => {
    mockState.dbFixtures = [
      repoWithPrs({
        pullRequests: [
          { id: "pr-1", sourceBranch: "feature", commitHash: "old-sha", status: "Pending", targetBranch: "main" },
        ],
      }),
    ];
    mockExecFileSync.mockImplementation(() => {
      throw new Error("command not found");
    });

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(ghResponse([{ number: 1, ref: "feature", sha: "new-sha" }])),
      );

    await pollOnce(triggerScan);

    // targetBranch was NOT updated (graceful skip — no call with targetBranch in data)
    expect(prisma.pullRequest.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetBranch: expect.any(String) }),
      }),
    );

    // commitHash WAS updated (sync cycle continues despite gh failure)
    expect(prisma.pullRequest.update).toHaveBeenCalledWith({
      where: { id: "pr-1" },
      data: { commitHash: "new-sha", status: "Pending" },
    });
    expect(triggerScan).toHaveBeenCalledWith("repo-1", "pr-1", "new-sha");
  });
});
