import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pullRequestFindUnique: vi.fn(),
  pullRequestFindFirst: vi.fn(),
  pullRequestUpdate: vi.fn(),
  admitAfkScanJob: vi.fn(),
  admitAfkScanJobForPr: vi.fn(),
  runGitInRepo: vi.fn(),
  ensureReviewTree: vi.fn(),
  ensureTipOverlay: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: (...a: unknown[]) => mocks.pullRequestFindUnique(...a),
      findFirst: (...a: unknown[]) => mocks.pullRequestFindFirst(...a),
      update: (...a: unknown[]) => mocks.pullRequestUpdate(...a),
    },
  },
}));

vi.mock("@/src/services/scanQueue", () => ({
  admitAfkScanJob: (...a: unknown[]) => mocks.admitAfkScanJob(...a),
  admitAfkScanJobForPr: (...a: unknown[]) => mocks.admitAfkScanJobForPr(...a),
}));

vi.mock("@/src/lib/repoAccess", () => ({
  runGitInRepo: (...a: unknown[]) => mocks.runGitInRepo(...a),
}));

import {
  orderPrIdsPreferringEvent,
  findPrIdForEvent,
  updatePrCommitToProviderTip,
  ensureTipReady,
  admitAfkAfterTipReady,
} from "@/src/lib/tipReadyAfk";

describe("orderPrIdsPreferringEvent", () => {
  it("puts preferred PR first and keeps others", () => {
    expect(orderPrIdsPreferringEvent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("returns original order when preferred missing", () => {
    expect(orderPrIdsPreferringEvent(["a", "b"], "z")).toEqual(["a", "b"]);
  });

  it("no-ops when preferred is null", () => {
    expect(orderPrIdsPreferringEvent(["a", "b"], null)).toEqual(["a", "b"]);
  });
});

describe("findPrIdForEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches by githubPrNumber first", async () => {
    mocks.pullRequestFindFirst.mockResolvedValueOnce({ id: "pr-42" });
    await expect(
      findPrIdForEvent("repo-1", { githubPrNumber: 42, sourceBranch: "feat" }),
    ).resolves.toBe("pr-42");
    expect(mocks.pullRequestFindFirst).toHaveBeenCalledWith({
      where: { repoId: "repo-1", githubPrNumber: 42 },
      select: { id: true },
    });
  });

  it("falls back to sourceBranch when number missing", async () => {
    mocks.pullRequestFindFirst.mockResolvedValueOnce({ id: "pr-feat" });
    await expect(
      findPrIdForEvent("repo-1", { sourceBranch: "feat/x" }),
    ).resolves.toBe("pr-feat");
    expect(mocks.pullRequestFindFirst).toHaveBeenCalledWith({
      where: { repoId: "repo-1", sourceBranch: "feat/x" },
      select: { id: true },
    });
  });

  it("returns null when no match", async () => {
    mocks.pullRequestFindFirst.mockResolvedValue(null);
    await expect(findPrIdForEvent("repo-1", { githubPrNumber: 9 })).resolves.toBeNull();
  });
});

describe("updatePrCommitToProviderTip", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates commit hash when provider tip differs", async () => {
    mocks.pullRequestFindUnique.mockResolvedValue({
      id: "pr-1",
      commitHash: "oldsha",
      status: "Completed",
    });
    mocks.pullRequestUpdate.mockResolvedValue({});
    const result = await updatePrCommitToProviderTip("pr-1", "newsha123");
    expect(result).toEqual({ previous: "oldsha", updated: true, headSha: "newsha123" });
    expect(mocks.pullRequestUpdate).toHaveBeenCalledWith({
      where: { id: "pr-1" },
      data: { commitHash: "newsha123", status: "Pending" },
    });
  });

  it("skips write when hash already matches", async () => {
    mocks.pullRequestFindUnique.mockResolvedValue({
      id: "pr-1",
      commitHash: "same",
      status: "Pending",
    });
    const result = await updatePrCommitToProviderTip("pr-1", "same");
    expect(result).toEqual({ previous: "same", updated: false, headSha: "same" });
    expect(mocks.pullRequestUpdate).not.toHaveBeenCalled();
  });

  it("returns not-found without update", async () => {
    mocks.pullRequestFindUnique.mockResolvedValue(null);
    await expect(updatePrCommitToProviderTip("missing", "sha")).resolves.toEqual({
      previous: null,
      updated: false,
      headSha: "sha",
      missing: true,
    });
  });
});

describe("ensureTipReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pullRequestFindUnique.mockResolvedValue({
      id: "pr-1",
      commitHash: "abc1234",
      status: "Pending",
      sourceBranch: "feat",
      targetBranch: "main",
      repoId: "repo-1",
    });
    mocks.pullRequestUpdate.mockResolvedValue({});
    mocks.runGitInRepo.mockResolvedValue({ exitCode: 0, stdout: "abc1234\n", stderr: "" });
  });

  it("updates provider tip hash then verifies head object in clone", async () => {
    mocks.pullRequestFindUnique.mockResolvedValue({
      id: "pr-1",
      commitHash: "old",
      status: "Completed",
      sourceBranch: "feat",
      targetBranch: "main",
      repoId: "repo-1",
    });
    mocks.runGitInRepo.mockImplementation(async (_repo: unknown, args: string[]) => {
      if (args[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    });

    const result = await ensureTipReady({
      repo: { id: "repo-1", path: "/tmp/repo" },
      prId: "pr-1",
      providerHeadSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      headRef: "feat",
      baseRef: "main",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result.prId).toBe("pr-1");
    }
    expect(mocks.pullRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        }),
      }),
    );
    expect(mocks.runGitInRepo).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(["fetch", "origin"]),
      expect.anything(),
    );
    // Must not write refs/heads/* (fails when base/main is checked out) or --prune.
    const fetchCall = mocks.runGitInRepo.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === "fetch",
    );
    expect(fetchCall?.[1]).toEqual([
      "fetch",
      "origin",
      "+refs/heads/feat:refs/remotes/origin/feat",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  it("fails closed with CLONE_FAILED when head/base fetch fails", async () => {
    mocks.runGitInRepo.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "Could not read from remote",
    });
    const result = await ensureTipReady({
      repo: { id: "repo-1", path: "/tmp/repo" },
      prId: "pr-1",
      providerHeadSha: "abc1234567890",
      headRef: "feat",
      baseRef: "main",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, gate: "CLONE_FAILED" }),
    );
    // Hash must not advance when fetch fails.
    expect(mocks.pullRequestUpdate).not.toHaveBeenCalled();
  });

  it("hash-only tip-ready when no clone path (poller / scan prelude path)", async () => {
    const result = await ensureTipReady({
      repo: { id: "repo-1", path: null, cloneUrl: null },
      prId: "pr-1",
      providerHeadSha: "pollersha1",
      requireClone: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headSha).toBe("pollersha1");
      expect(result.mode).toBe("hash-only");
    }
    expect(mocks.runGitInRepo).not.toHaveBeenCalled();
  });

  it("fails when PR missing", async () => {
    mocks.pullRequestFindUnique.mockResolvedValue(null);
    const result = await ensureTipReady({
      repo: { id: "repo-1", path: "/tmp/r" },
      prId: "gone",
      providerHeadSha: "sha",
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, gate: "TIP_CONTEXT_FAILED" }),
    );
  });
});

describe("admitAfkAfterTipReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admitAfkScanJob.mockResolvedValue({ jobId: "j1", state: "queued" });
    mocks.admitAfkScanJobForPr.mockResolvedValue({ jobId: "j1", state: "queued" });
    mocks.pullRequestFindFirst.mockResolvedValue({ id: "pr-event" });
    mocks.pullRequestFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "pr-event") {
        return {
          id: "pr-event",
          commitHash: "eventsha",
          status: "Pending",
          sourceBranch: "feat",
          targetBranch: "main",
          repoId: "repo-1",
        };
      }
      return {
        id: where.id,
        commitHash: "othersha",
        status: "Pending",
        sourceBranch: "other",
        targetBranch: "main",
        repoId: "repo-1",
      };
    });
    mocks.pullRequestUpdate.mockResolvedValue({});
    mocks.runGitInRepo.mockResolvedValue({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  it("does not admit when clone already failed", async () => {
    const out = await admitAfkAfterTipReady({
      repoId: "repo-1",
      prIds: ["pr-1"],
      triggerReason: "webhook",
      cloneFailed: true,
      cloneError: "git fetch failed",
    });
    expect(out.admitted).toBe(0);
    expect(out.error).toContain("git fetch failed");
    expect(mocks.admitAfkScanJob).not.toHaveBeenCalled();
    expect(mocks.admitAfkScanJobForPr).not.toHaveBeenCalled();
  });

  it("prefers event PR for admit order and updates its hash", async () => {
    const tipSha = "abcdef0123456789abcdef0123456789abcdef01";
    const otherSha = "1111111111111111111111111111111111111111";
    const admitOrder: string[] = [];
    mocks.admitAfkScanJob.mockImplementation(async (input: { prId: string }) => {
      admitOrder.push(input.prId);
      return { jobId: `j-${input.prId}`, state: "queued" };
    });
    mocks.pullRequestFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "pr-event") {
        return {
          id: "pr-event",
          commitHash: "oldsha01",
          status: "Pending",
          sourceBranch: "feat",
          targetBranch: "main",
          repoId: "repo-1",
        };
      }
      return {
        id: where.id,
        commitHash: otherSha,
        status: "Pending",
        sourceBranch: "other",
        targetBranch: "main",
        repoId: "repo-1",
      };
    });
    mocks.runGitInRepo.mockImplementation(async (_r: unknown, args: string[]) => {
      if (args[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") {
        const ref = String(args[2] || "");
        if (ref.includes(tipSha) || ref.includes("feat")) {
          return { exitCode: 0, stdout: `${tipSha}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: `${otherSha}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const out = await admitAfkAfterTipReady({
      repoId: "repo-1",
      prIds: ["pr-other", "pr-event"],
      triggerReason: "webhook",
      repo: { id: "repo-1", path: "/tmp/repo" },
      event: {
        githubPrNumber: 42,
        sourceBranch: "feat",
        headSha: tipSha,
        headRef: "feat",
        baseRef: "main",
      },
    });

    expect(out.preferredPrId).toBe("pr-event");
    expect(admitOrder[0]).toBe("pr-event");
    expect(out.admitted).toBeGreaterThanOrEqual(1);
    expect(mocks.pullRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pr-event" },
        data: expect.objectContaining({
          commitHash: tipSha,
        }),
      }),
    );
  });

  it("skips AFK admit when tip-ready fails for a PR", async () => {
    mocks.runGitInRepo.mockResolvedValue({
      exitCode: 128,
      stdout: "",
      stderr: "fetch failed",
    });
    const out = await admitAfkAfterTipReady({
      repoId: "repo-1",
      prIds: ["pr-event"],
      triggerReason: "webhook",
      repo: { id: "repo-1", path: "/tmp/repo" },
      event: {
        githubPrNumber: 1,
        headSha: "abc",
        headRef: "feat",
        baseRef: "main",
      },
    });
    expect(out.admitted).toBe(0);
    expect(mocks.admitAfkScanJob).not.toHaveBeenCalled();
    expect(out.tipReadyFailed?.length).toBeGreaterThan(0);
  });

  it("admits with hash-only tip-ready when repo has no local clone", async () => {
    mocks.pullRequestFindFirst.mockResolvedValue(null);
    const out = await admitAfkAfterTipReady({
      repoId: "repo-1",
      prIds: ["pr-1"],
      triggerReason: "polling",
      // no path / clone — poller path; scan prelude guarantees tip tree later
      providerTips: { "pr-1": "sha-from-poller" },
    });
    expect(out.admitted).toBe(1);
    expect(mocks.admitAfkScanJob).toHaveBeenCalledWith(
      expect.objectContaining({
        prId: "pr-1",
        commitHash: "sha-from-poller",
        triggerReason: "polling",
      }),
    );
  });
});
