import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  enforceScope: vi.fn(),
  repoFindMany: vi.fn(),
  repoFindUnique: vi.fn(),
  prCreate: vi.fn(),
  prFindMany: vi.fn(),
  fileFindMany: vi.fn(),
  readCommitCount: vi.fn(),
  getRealPrs: vi.fn(),
  discoveredPrs: [] as Record<string, unknown>[],
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.authenticate,
  enforceRepoScope: mocks.enforceScope,
}));
vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: { findMany: mocks.repoFindMany, findUnique: mocks.repoFindUnique },
    pullRequest: { create: mocks.prCreate, findMany: mocks.prFindMany },
    prFile: { findMany: mocks.fileFindMany },
  },
}));
vi.mock("@/src/lib/getRealPrs", () => ({ getRealPrs: mocks.getRealPrs }));
vi.mock("@/src/lib/prSizeProfile.server", () => ({
  readPrCommitCount: mocks.readCommitCount,
}));

import { GET } from "../src/app/api/repos/[id]/prs/route";
import { pollOnce } from "../src/lib/prPollingWorker";

describe("server-discovered PR dashboard read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.discoveredPrs = [];
    mocks.repoFindMany.mockResolvedValue([{
      id: "repo-discovery",
      name: "Discovery repo",
      provider: "github",
      cloneUrlHttps: "https://github.com/owner/discovery-repo.git",
      baseBranch: "main",
      patCipher: null,
      patIv: null,
      patTag: null,
      autoRescanPolicy: "enabled",
      isPollingEnabled: true,
      pullRequests: [],
    }]);
    mocks.prCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      mocks.discoveredPrs.push(data);
      return data;
    });
    mocks.prFindMany.mockImplementation(async () => mocks.discoveredPrs);
    mocks.authenticate.mockResolvedValue({ ok: true, userId: "user-1" });
    mocks.enforceScope.mockReturnValue(null);
    mocks.repoFindUnique.mockResolvedValue({
      id: "repo-discovery",
      name: "Discovery repo",
      path: null,
      cloneUrl: null,
      baseBranch: "main",
    });
    mocks.fileFindMany.mockResolvedValue([]);
    mocks.readCommitCount.mockResolvedValue(0);
  });

  it("returns a Pending PR discovered while no dashboard was open", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [{
        number: 7,
        title: "New PR",
        body: null,
        user: { login: "alice" },
        created_at: "2026-07-19T00:00:00Z",
        base: { ref: "main" },
        head: { sha: "sha-1", ref: "feature/new" },
        state: "open",
      }],
    } as Response);
    const triggerScan = vi.fn();
    await pollOnce(triggerScan);

    const response = await GET(new Request("http://localhost/api/repos/repo-discovery/prs"), {
      params: Promise.resolve({ id: "repo-discovery" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: "poll-pr-repo-discovery-7",
        status: "Pending",
        commitHash: "sha-1",
      }),
    ]);
    expect(mocks.prFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { repoId: "repo-discovery", status: { not: "Merged" } },
    }));
    expect(mocks.prCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "Pending", commitHash: "sha-1" }),
    });
    expect(mocks.getRealPrs).not.toHaveBeenCalled();
  });
});
