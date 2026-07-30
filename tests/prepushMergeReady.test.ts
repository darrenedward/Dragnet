import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAdmit: vi.fn(),
  mockWait: vi.fn(),
  mockRepoFindFirst: vi.fn(),
  mockPrFindFirst: vi.fn(),
  mockPrUpdate: vi.fn(),
  mockRunFindUnique: vi.fn(),
  mockFindingFindMany: vi.fn(),
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateApiRequest: mocks.mockAuth,
}));

vi.mock("@/src/services/scanQueue", () => ({
  admitScanJobForPr: mocks.mockAdmit,
  waitForScanJob: mocks.mockWait,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.mockRepoFindFirst },
    pullRequest: {
      findFirst: mocks.mockPrFindFirst,
      update: mocks.mockPrUpdate,
    },
    reviewRun: { findUnique: mocks.mockRunFindUnique },
    reviewFinding: { findMany: mocks.mockFindingFindMany },
  },
}));

import { POST } from "../src/app/api/hooks/prepush/route";

function req(body: unknown) {
  return new Request("http://localhost/api/hooks/prepush", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hooks/prepush — isMergeReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuth.mockResolvedValue({ ok: true, userId: "u1" });
    mocks.mockRepoFindFirst.mockResolvedValue({ id: "repo-1", path: "/tmp/r" });
    mocks.mockPrFindFirst.mockResolvedValue({ id: "pr-1", commitHash: "abc" });
    mocks.mockAdmit.mockResolvedValue({ jobId: "job-1", state: "queued", queuePosition: 1 });
    mocks.mockWait.mockResolvedValue({ state: "completed", reviewRunId: "run-1", errorMessage: null });
    mocks.mockFindingFindMany.mockResolvedValue([]);
  });

  it("fails when rating is null", async () => {
    mocks.mockRunFindUnique.mockResolvedValue({
      rating: null,
      reliability: "complete",
      model: "m",
      status: "completed",
      outcome: "reviewed",
      refused: false,
    });
    const res = await POST(req({ branch: "feat", repoPath: "/tmp/r" }));
    const body = await res.json();
    expect(body.passed).toBe(false);
    expect(body.mergeReady).toBe(false);
    expect(body.mergeBlockReason).toBe("null_rating");
  });

  it("passes when rating >= 8 and complete", async () => {
    mocks.mockRunFindUnique.mockResolvedValue({
      rating: 9,
      reliability: "complete",
      model: "m",
      status: "completed",
      outcome: "reviewed",
      refused: false,
    });
    const res = await POST(req({ branch: "feat", repoPath: "/tmp/r" }));
    const body = await res.json();
    expect(body.passed).toBe(true);
    expect(body.mergeReady).toBe(true);
    expect(body.mergeBlockReason).toBeNull();
  });

  it("fails incomplete security reliability", async () => {
    mocks.mockRunFindUnique.mockResolvedValue({
      rating: 10,
      reliability: "incomplete_security_review",
      model: "m",
      status: "completed",
      outcome: "reviewed",
      refused: false,
    });
    const res = await POST(req({ branch: "feat", repoPath: "/tmp/r" }));
    const body = await res.json();
    expect(body.passed).toBe(false);
    expect(body.mergeBlockReason).toBe("reliability_incomplete");
  });
});
