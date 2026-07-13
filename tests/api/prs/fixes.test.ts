import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockAuthenticateSessionOrKey: vi.fn(),
  mockBugFixEventFindMany: vi.fn(),
  mockReviewRunCount: vi.fn(),
  mockPullRequestFindUnique: vi.fn(),
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.mockAuthenticateSessionOrKey,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    pullRequest: {
      findUnique: mocks.mockPullRequestFindUnique,
    },
    bugFixEvent: {
      findMany: mocks.mockBugFixEventFindMany,
    },
    reviewRun: {
      count: mocks.mockReviewRunCount,
    },
  },
}));

import { GET } from "@/src/app/api/prs/[prId]/fixes/route";

function makeRequest(prId: string): Request {
  return new Request(`http://localhost/api/prs/${prId}/fixes`, { method: "GET" });
}

describe("GET /api/prs/[prId]/fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({
      ok: true,
      userId: "u1",
    });
  });

  it("returns 200 with empty shape when PR has no fix events", async () => {
    mocks.mockPullRequestFindUnique.mockResolvedValue({ id: "pr-1" });
    mocks.mockBugFixEventFindMany.mockResolvedValue([]);
    mocks.mockReviewRunCount.mockResolvedValue(1);

    const res = await GET(makeRequest("pr-1"), {
      params: Promise.resolve({ prId: "pr-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ fixedCount: 0, events: [], hasPriorRun: false });
  });

  it("returns 200 with single-event shape", async () => {
    const event = {
      id: "evt-1",
      filename: "src/handler.ts",
      line: 42,
      category: "Correctness",
      severity: "blocker",
      fixedAt: "2026-07-14T00:00:00.000Z",
      fixedAtScanId: "run-2",
      originatedAtScanId: "run-1",
      sourceFindingId: "find-1",
    };
    mocks.mockPullRequestFindUnique.mockResolvedValue({ id: "pr-1" });
    mocks.mockBugFixEventFindMany.mockResolvedValue([event]);
    mocks.mockReviewRunCount.mockResolvedValue(2);

    const res = await GET(makeRequest("pr-1"), {
      params: Promise.resolve({ prId: "pr-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixedCount).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: "evt-1",
      filename: "src/handler.ts",
      line: 42,
      category: "Correctness",
      severity: "blocker",
    });
    expect(body.hasPriorRun).toBe(true);
  });

  it("orders events by fixedAt descending", async () => {
    const older = {
      id: "evt-old",
      filename: "a.ts",
      line: 1,
      category: "Security",
      severity: "blocker",
      fixedAt: "2026-07-13T00:00:00.000Z",
      fixedAtScanId: "run-2",
      originatedAtScanId: "run-1",
      sourceFindingId: "find-1",
    };
    const newer = {
      id: "evt-new",
      filename: "b.ts",
      line: 5,
      category: "Correctness",
      severity: "blocker",
      fixedAt: "2026-07-14T00:00:00.000Z",
      fixedAtScanId: "run-3",
      originatedAtScanId: "run-1",
      sourceFindingId: "find-2",
    };
    mocks.mockPullRequestFindUnique.mockResolvedValue({ id: "pr-1" });
    mocks.mockBugFixEventFindMany.mockResolvedValue([newer, older]);
    mocks.mockReviewRunCount.mockResolvedValue(3);

    const res = await GET(makeRequest("pr-1"), {
      params: Promise.resolve({ prId: "pr-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: any) => e.id)).toEqual(["evt-new", "evt-old"]);
  });

  it("returns events with any severity from the DB (severity-scope is at persistence layer)", async () => {
    const warningEvent = {
      id: "evt-warn",
      filename: "src/config.ts",
      line: 10,
      category: "Style",
      severity: "warning",
      fixedAt: "2026-07-14T00:00:00.000Z",
      fixedAtScanId: "run-2",
      originatedAtScanId: "run-1",
      sourceFindingId: "find-1",
    };
    mocks.mockPullRequestFindUnique.mockResolvedValue({ id: "pr-1" });
    mocks.mockBugFixEventFindMany.mockResolvedValue([warningEvent]);
    mocks.mockReviewRunCount.mockResolvedValue(2);

    const res = await GET(makeRequest("pr-1"), {
      params: Promise.resolve({ prId: "pr-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixedCount).toBe(1);
    expect(body.events[0].severity).toBe("warning");
  });

  it("returns 401 when auth is missing", async () => {
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({
      ok: false,
      error: "Unauthorized",
    });

    const res = await GET(makeRequest("pr-no-auth"), {
      params: Promise.resolve({ prId: "pr-no-auth" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 404 when PR does not exist", async () => {
    mocks.mockPullRequestFindUnique.mockResolvedValue(null);

    const res = await GET(makeRequest("pr-missing"), {
      params: Promise.resolve({ prId: "pr-missing" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("PR not found");
  });

  it("sets Cache-Control header to max-age=0, must-revalidate", async () => {
    mocks.mockPullRequestFindUnique.mockResolvedValue({ id: "pr-1" });
    mocks.mockBugFixEventFindMany.mockResolvedValue([]);
    mocks.mockReviewRunCount.mockResolvedValue(1);

    const res = await GET(makeRequest("pr-1"), {
      params: Promise.resolve({ prId: "pr-1" }),
    });
    expect(res.headers.get("Cache-Control")).toBe("max-age=0, must-revalidate");
  });
});
