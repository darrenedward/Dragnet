import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockGroupBy: vi.fn(),
  mockRequireSession: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    apiKey: {
      groupBy: mocks.mockGroupBy,
    },
  },
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

import { GET } from "../src/app/api/team/member-stats/route";

describe("GET /api/team/member-stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("requires session", async () => {
    mocks.mockRequireSession.mockRejectedValue(new Error("Unauthorized"));
    const req = new Request("http://localhost/api/team/member-stats");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns counts keyed by userId", async () => {
    mocks.mockGroupBy.mockResolvedValue([
      { userId: "user-1", _count: { _all: 3 } },
      { userId: "user-2", _count: { _all: 1 } },
    ]);
    const req = new Request("http://localhost/api/team/member-stats");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.counts).toEqual({ "user-1": 3, "user-2": 1 });
  });

  it("filters to non-revoked keys with userId set", async () => {
    mocks.mockGroupBy.mockResolvedValue([]);
    const req = new Request("http://localhost/api/team/member-stats");
    await GET(req);
    const callArgs = mocks.mockGroupBy.mock.calls[0][0];
    expect(callArgs.where.revoked).toBe(false);
    expect(callArgs.where.userId).toEqual({ not: null });
  });

  it("returns empty counts when no rows", async () => {
    mocks.mockGroupBy.mockResolvedValue([]);
    const req = new Request("http://localhost/api/team/member-stats");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.counts).toEqual({});
  });
});