import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #147 — DRAGNET_REPO_ID is optional when the Bearer key is already per-repo scoped.
 * Command route must default repoId from auth.repoId.
 */

const mocks = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  pullRequestFindMany: vi.fn(),
  reviewRunFindFirst: vi.fn(),
  prFileFindMany: vi.fn(),
  repositoryFindUnique: vi.fn(),
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateApiRequest: mocks.authenticateApiRequest,
  enforceRepoScope: () => null,
  enforcePrRepoScope: async () => null,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findMany: (...args: unknown[]) => mocks.pullRequestFindMany(...args),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    reviewRun: { findFirst: (...args: unknown[]) => mocks.reviewRunFindFirst(...args) },
    prFile: { findMany: (...args: unknown[]) => mocks.prFileFindMany(...args) },
    repository: { findUnique: (...args: unknown[]) => mocks.repositoryFindUnique(...args) },
    scanJob: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/src/lib/prSizeProfile.server", () => ({
  readPrCommitCount: vi.fn(async () => 1),
}));

vi.mock("@/src/lib/reviewFreshness", () => ({
  getLatestCompletedReview: vi.fn(async () => ({
    reviewRun: null,
    findings: [],
    stale: false,
    staleReason: null,
    rejectedCount: 0,
    regressions: [],
  })),
  getLatestTerminalReview: vi.fn(async () => ({
    reviewRun: null,
    findings: [],
    stale: false,
    staleReason: null,
  })),
  getActiveScan: vi.fn(async () => null),
  getRecentRuns: vi.fn(async () => []),
  computeDiffHash: vi.fn(),
  computeReviewConfigHash: vi.fn(),
  shortHash: vi.fn(),
  createReviewRun: vi.fn(),
  completeReviewRun: vi.fn(),
}));

vi.mock("@/src/lib/prStackTopology", () => ({
  computeStackTopology: vi.fn(() => new Map()),
}));

describe("command route per-repo key default (#147)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pullRequestFindMany.mockResolvedValue([]);
    mocks.prFileFindMany.mockResolvedValue([]);
    mocks.repositoryFindUnique.mockResolvedValue({
      id: "repo-from-key",
      path: "/tmp",
      baseBranch: "main",
    });
  });

  it("prlist uses auth.repoId when body omits repoId (per-repo key)", async () => {
    mocks.authenticateApiRequest.mockResolvedValue({
      ok: true,
      repoId: "repo-from-key",
      userId: "user-1",
    });
    const { POST } = await import("../src/app/api/command/[[...args]]/route");
    const req = new Request("http://localhost:3300/api/command", {
      method: "POST",
      headers: {
        Authorization: "Bearer dr_testkey",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "prlist" }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "Success", type: "list", repoId: "repo-from-key" });
    expect(mocks.pullRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ repoId: "repo-from-key" }) }),
    );
  });

  it("prlist still requires repoId when key is global (auth.repoId null)", async () => {
    mocks.authenticateApiRequest.mockResolvedValue({
      ok: true,
      repoId: null,
      userId: "user-1",
    });
    const { POST } = await import("../src/app/api/command/[[...args]]/route");
    const req = new Request("http://localhost:3300/api/command", {
      method: "POST",
      headers: {
        Authorization: "Bearer dr_global",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "prlist" }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/repoId/i);
  });
});
