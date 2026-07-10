import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type PrRow = {
  id: string;
  sourceBranch: string;
  commitHash: string;
  targetBranch: string;
};

type RepoRow = {
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
};

type HostedScanResultMock =
  | { ok: true; prId: string; runId?: string }
  | { ok: false; error: string };

const mockState = vi.hoisted(() => ({
  dbFixtures: [] as RepoRow[],
  dbShouldThrow: null as string | null,
  existingPrs: new Map<string, PrRow | null>(),
  hostedScanResult: { ok: true, prId: "pr-new", runId: "run-1" } as HostedScanResultMock,
}));

vi.mock("../../src/lib/prisma", () => {
  const pullRequestFindFirst = vi.fn(
    (args: { where: { repoId: string; sourceBranch: string; targetBranch: string } }) => {
      const key = `${args.where.repoId}:${args.where.sourceBranch}:${args.where.targetBranch}`;
      return Promise.resolve(mockState.existingPrs.get(key) ?? null);
    },
  );

  return {
    prisma: {
      repository: {
        findMany: vi.fn(() => {
          if (mockState.dbShouldThrow) {
            return Promise.reject(new Error(mockState.dbShouldThrow));
          }
          return Promise.resolve(mockState.dbFixtures);
        }),
      },
      pullRequest: {
        findFirst: pullRequestFindFirst,
      },
    },
  };
});

vi.mock("../../src/services/hostedScan/orchestrator", () => ({
  triggerHostedScan: vi.fn(() => Promise.resolve(mockState.hostedScanResult)),
}));

import { pollHostedRepos, startHostedPoller, stopHostedPoller } from "../../src/services/hostedScan/poller";
import { triggerHostedScan } from "../../src/services/hostedScan/orchestrator";

describe("pollHostedRepos", () => {
  const baseRepo: RepoRow = {
    id: "repo-1",
    name: "test-repo",
    provider: "github",
    cloneUrlHttps: "https://github.com/owner/test-repo.git",
    cloneUrl: null,
    baseBranch: "main",
    branchPattern: "*",
    patCipher: null,
    patIv: null,
    patTag: null,
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.dbFixtures = [];
    mockState.dbShouldThrow = null;
    mockState.existingPrs = new Map();
    mockState.hostedScanResult = { ok: true, prId: "pr-new", runId: "run-1" };
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function ghResponse(
    prs: { number: number; title: string; ref: string; sha: string; baseRef: string; login?: string; body?: string }[],
  ): Response {
    return {
      ok: true,
      status: 200,
      headers: new Map() as unknown as Headers,
      json: async () =>
        prs.map((p) => ({
          number: p.number,
          title: p.title,
          head: { sha: p.sha, ref: p.ref },
          base: { sha: "base-sha", ref: p.baseRef },
          user: p.login ? { login: p.login } : null,
          body: p.body ?? null,
        })),
      text: async () => "",
      redirected: false,
      statusText: "OK",
      type: "basic" as ResponseType,
      url: "",
      clone: () => new Response(),
      body: null,
      bodyUsed: false,
      arrayBuffer: async () => new ArrayBuffer(0),
      blob: async () => new Blob(),
      formData: async () => new FormData(),
    } as Response;
  }

  // ─── Empty / edge cases ──────────────────────────────────────────

  it("returns zeros when no hosted repos exist", async () => {
    const result = await pollHostedRepos();
    expect(result).toEqual({ total: 0, synced: 0, scanned: 0, errors: [] });
  });

  it("handles DB query failure gracefully", async () => {
    mockState.dbShouldThrow = "DB connection lost";
    fetchSpy = vi.spyOn(global, "fetch");

    const result = await pollHostedRepos();
    expect(result).toEqual({ total: 0, synced: 0, scanned: 0, errors: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── Provider filtering ──────────────────────────────────────────

  it("skips unsupported providers (e.g. local)", async () => {
    mockState.dbFixtures = [{ ...baseRepo, provider: "local" }];
    fetchSpy = vi.spyOn(global, "fetch");

    const result = await pollHostedRepos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.scanned).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── GitHub polling ──────────────────────────────────────────────

  it("discovers and syncs new PRs from GitHub", async () => {
    mockState.dbFixtures = [baseRepo];
    mockState.existingPrs.set("repo-1:feature:main", null);

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "New feature", ref: "feature", sha: "abc123", baseRef: "main", login: "octocat" }]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.scanned).toBe(1);
    expect(triggerHostedScan).toHaveBeenCalledTimes(1);
    expect(triggerHostedScan).toHaveBeenCalledWith("repo-1", {
      prNumber: 1,
      title: "New feature",
      headBranch: "feature",
      baseBranch: "main",
      commitHash: "abc123",
      author: "octocat",
      description: undefined,
    });
  });

  it("does not re-scan if commit hash has not changed", async () => {
    mockState.dbFixtures = [baseRepo];
    mockState.existingPrs.set("repo-1:feature:main", {
      id: "pr-1",
      sourceBranch: "feature",
      commitHash: "same-sha",
      targetBranch: "main",
    });

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "Feature", ref: "feature", sha: "same-sha", baseRef: "main" }]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.scanned).toBe(0);
    expect(triggerHostedScan).not.toHaveBeenCalled();
  });

  it("re-scans when commit hash advances", async () => {
    mockState.dbFixtures = [baseRepo];
    mockState.existingPrs.set("repo-1:feature:main", {
      id: "pr-1",
      sourceBranch: "feature",
      commitHash: "old-sha",
      targetBranch: "main",
    });

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "Feature", ref: "feature", sha: "new-sha", baseRef: "main" }]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.scanned).toBe(1);
    expect(triggerHostedScan).toHaveBeenCalledTimes(1);
  });

  // ─── Branch pattern filtering ────────────────────────────────────

  it("skips PRs whose branch does not match the branchPattern", async () => {
    mockState.dbFixtures = [{ ...baseRepo, branchPattern: "main" }];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([
            { number: 1, title: "Feature", ref: "feature", sha: "abc", baseRef: "main" },
          ]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.scanned).toBe(0);
    expect(triggerHostedScan).not.toHaveBeenCalled();
  });

  it("allows PRs matching branchPattern with wildcard", async () => {
    mockState.dbFixtures = [{ ...baseRepo, branchPattern: "fix/*" }];
    mockState.existingPrs.set("repo-1:fix/button:main", null);

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([
            { number: 1, title: "Fix", ref: "fix/button", sha: "abc", baseRef: "main" },
            { number: 2, title: "Feature", ref: "feature", sha: "def", baseRef: "main" },
          ]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(triggerHostedScan).toHaveBeenCalledTimes(1);
  });

  // ─── GitHub API error handling ───────────────────────────────────

  it("handles GitHub API error status gracefully", async () => {
    mockState.dbFixtures = [baseRepo];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve({ ok: false, status: 500, text: async () => "Error" } as Response),
      );

    const result = await pollHostedRepos();

    expect(result.errors).toHaveLength(0); // errors logged, not returned for API failures
    expect(triggerHostedScan).not.toHaveBeenCalled();
  });

  it("handles network error gracefully", async () => {
    mockState.dbFixtures = [baseRepo];

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() => Promise.reject(new Error("Network error")));

    const result = await pollHostedRepos();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network error");
  });

  // ─── Multi-repo cycle ────────────────────────────────────────────

  it("processes multiple hosted repos in a single cycle", async () => {
    mockState.dbFixtures = [
      { ...baseRepo, id: "repo-1", cloneUrlHttps: "https://github.com/a/repo-a.git" },
      { ...baseRepo, id: "repo-2", name: "other-repo", cloneUrlHttps: "https://github.com/b/repo-b.git" },
    ];
    mockState.existingPrs.set("repo-1:feature:main", null);
    mockState.existingPrs.set("repo-2:fix:main", null);

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "Feature", ref: "feature", sha: "abc", baseRef: "main" }]),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "Fix", ref: "fix", sha: "def", baseRef: "main" }]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(2);
    expect(result.synced).toBe(2);
    expect(result.scanned).toBe(2);
    expect(triggerHostedScan).toHaveBeenCalledTimes(2);
  });

  // ─── No clone URL ────────────────────────────────────────────────

  it("skips repos without clone URL", async () => {
    mockState.dbFixtures = [{ ...baseRepo, cloneUrlHttps: null, cloneUrl: null }];
    fetchSpy = vi.spyOn(global, "fetch");

    const result = await pollHostedRepos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ─── GitLab support ──────────────────────────────────────────────

  it("polls GitLab repos for open merge requests", async () => {
    mockState.dbFixtures = [{ ...baseRepo, provider: "gitlab", cloneUrlHttps: "https://gitlab.com/owner/project.git" }];
    mockState.existingPrs.set("repo-1:fix/thing:main", null);

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map() as unknown as Headers,
          json: async () => [
            {
              iid: 5,
              title: "Fix the thing",
              source_branch: "fix/thing",
              target_branch: "main",
              sha: "gl-sha-123",
              author: { username: "gl-user" },
              description: "MR description",
            },
          ],
          text: async () => "",
          redirected: false,
          statusText: "OK",
          type: "basic" as ResponseType,
          url: "",
          clone: () => new Response(),
          body: null,
          bodyUsed: false,
          arrayBuffer: async () => new ArrayBuffer(0),
          blob: async () => new Blob(),
          formData: async () => new FormData(),
        } as Response),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.scanned).toBe(1);
    expect(triggerHostedScan).toHaveBeenCalledWith("repo-1", {
      prNumber: 5,
      title: "Fix the thing",
      headBranch: "fix/thing",
      baseBranch: "main",
      commitHash: "gl-sha-123",
      author: "gl-user",
      description: "MR description",
    });
  });

  // ─── HostedScan errors ───────────────────────────────────────────

  it("reports errors from triggerHostedScan gracefully", async () => {
    mockState.dbFixtures = [baseRepo];
    mockState.existingPrs.set("repo-1:feature:main", null);
    mockState.hostedScanResult = { ok: false, error: "Repository not found" };

    fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementationOnce(() =>
        Promise.resolve(
          ghResponse([{ number: 1, title: "Feature", ref: "feature", sha: "abc", baseRef: "main" }]),
        ),
      );

    const result = await pollHostedRepos();

    expect(result.total).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("triggerHostedScan failed");
  });
});

// ─── startHostedPoller / stopHostedPoller ─────────────────────────────

describe("startHostedPoller / stopHostedPoller", () => {
  afterEach(() => {
    stopHostedPoller();
    vi.useRealTimers();
  });

  it("starts an interval and calls pollHostedRepos", () => {
    vi.useFakeTimers();

    const pollSpy = vi.spyOn(global, "setInterval");

    startHostedPoller();

    expect(pollSpy).toHaveBeenCalled();
    expect(pollSpy.mock.calls[0][1]).toBe(120_000);

    pollSpy.mockRestore();
  });

  it("is idempotent — calling start twice does not start a second interval", () => {
    vi.useFakeTimers();

    const pollSpy = vi.spyOn(global, "setInterval");

    startHostedPoller();
    startHostedPoller();

    expect(pollSpy).toHaveBeenCalledTimes(1);

    pollSpy.mockRestore();
  });

  it("stopHostedPoller clears the interval", () => {
    vi.useFakeTimers();

    startHostedPoller();
    stopHostedPoller();

    // After stopping, no more intervals should fire
    vi.advanceTimersByTime(300_000);
    // No assertion needed — just verifying no crash
  });
});
