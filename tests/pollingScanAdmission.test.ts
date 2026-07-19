import { beforeEach, describe, expect, it, vi } from "vitest";

const { scanJob, repository, pullRequest, jobs } = vi.hoisted(() => ({
  scanJob: { upsert: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  repository: { findMany: vi.fn() },
  pullRequest: { create: vi.fn(), update: vi.fn() },
  jobs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: { scanJob, repository, pullRequest },
}));
vi.mock("@/src/lib/prSizeConfig", () => ({
  readLimits: () => ({ maxConcurrentScans: 1 }),
}));
vi.mock("@/src/lib/autoRescanPolicy", () => ({
  isAutoRescanEnabled: () => true,
}));

import { pollOnce } from "@/src/lib/prPollingWorker";

describe("polling scan admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobs.clear();
    scanJob.count.mockResolvedValue(0);
    scanJob.updateMany.mockResolvedValue({ count: 0 });
    scanJob.upsert.mockImplementation(async ({ where, create }: { where: { prId_commitHash: { prId: string; commitHash: string } }; create: Record<string, unknown> }) => {
      const key = `${where.prId_commitHash.prId}:${where.prId_commitHash.commitHash}`;
      const existing = jobs.get(key);
      if (existing) return existing;
      const job = {
        ...create,
        id: `job-${jobs.size + 1}`,
        prId: where.prId_commitHash.prId,
        commitHash: where.prId_commitHash.commitHash,
      state: "queued",
      claimedAt: null,
      leaseExpiresAt: null,
      createdAt: new Date("2026-07-19T00:00:00Z"),
      };
      jobs.set(key, job);
      return job;
    });
    repository.findMany.mockImplementation(() => [{
      id: "repo-1",
      name: "polling-repo",
      provider: "github",
      cloneUrlHttps: "https://github.com/owner/polling-repo.git",
      baseBranch: "main",
      patCipher: null,
      patIv: null,
      patTag: null,
      autoRescanPolicy: "enabled",
      pullRequests: [],
    }]);
    pullRequest.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const repo = repository.findMany.mock.results[repository.findMany.mock.results.length - 1].value[0];
      repo.pullRequests.push(data);
      return data;
    });
    pullRequest.update.mockResolvedValue({});
  });

  it("admits the observed SHA as automatic work", async () => {
    const { admitPollingScan } = await import("@/src/lib/pollingScanAdmission");

    await admitPollingScan({ repoId: "repo-1", prId: "pr-1", commitHash: "sha-1" });

    expect(scanJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { prId_commitHash: { prId: "pr-1", commitHash: "sha-1" } },
      create: expect.objectContaining({
        repoId: "repo-1",
        commitHash: "sha-1",
        triggerReason: "auto",
        priority: 0,
      }),
      update: {},
    }));
  });

  it("coalesces repeated polling admission for one revision", async () => {
    const { admitPollingScan } = await import("@/src/lib/pollingScanAdmission");

    await admitPollingScan({ repoId: "repo-1", prId: "pr-1", commitHash: "sha-1" });
    await admitPollingScan({ repoId: "repo-1", prId: "pr-1", commitHash: "sha-1" });

    expect(scanJob.upsert).toHaveBeenCalledTimes(2);
    expect(jobs.size).toBe(1);
    expect((await admitPollingScan({ repoId: "repo-1", prId: "pr-1", commitHash: "sha-1" })).jobId).toBe("job-1");
    expect(scanJob.upsert.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: { prId_commitHash: { prId: "pr-1", commitHash: "sha-1" } },
      update: {},
    }));
  });

  it("routes repeated polling cycles through one durable automatic job", async () => {
    const responses = ["sha-1", "sha-1"].map((sha) => ({
      ok: true,
      status: 200,
      headers: new Headers({ etag: `\"${sha}\"` }),
      json: async () => [{
        number: 7,
        title: "PR 7",
        body: null,
        user: { login: "alice" },
        created_at: "2026-07-19T00:00:00Z",
        base: { ref: "main" },
        head: { sha, ref: "feature/7" },
        state: "open",
      }],
    }) as Response);
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);

    const { admitPollingScan } = await import("@/src/lib/pollingScanAdmission");
    await pollOnce(async (repoId, prId, commitHash) => {
      await admitPollingScan({ repoId, prId, commitHash });
    });
    await pollOnce(async (repoId, prId, commitHash) => {
      await admitPollingScan({ repoId, prId, commitHash });
    });

    expect(jobs.size).toBe(1);
    expect([...jobs.values()][0]).toMatchObject({
      prId: "poll-pr-repo-1-7",
      commitHash: "sha-1",
      triggerReason: "auto",
    });
  });
});
