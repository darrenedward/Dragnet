import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockRepositoryFindMany: vi.fn(),
  mockMemberFindFirst: vi.fn(),
  mockVerifyInviterIsOwnerOrAdmin: vi.fn(),
  mockInvitationCreate: vi.fn(),
  mockPendingRepoAssignmentCreateMany: vi.fn(),
}));

vi.mock("../src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: mocks.mockRepositoryFindMany,
    },
    member: {
      findFirst: mocks.mockMemberFindFirst,
    },
    invitation: {
      create: mocks.mockInvitationCreate,
    },
    pendingRepoAssignment: {
      createMany: mocks.mockPendingRepoAssignmentCreateMany,
    },
  },
}));

vi.mock("../src/lib/apiAuth", () => ({
  verifyInviterIsOwnerOrAdmin: mocks.mockVerifyInviterIsOwnerOrAdmin,
}));

import { POST } from "../src/app/api/team/invite/route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/team/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/team/invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRequireSession.mockResolvedValue({ user: { id: "u-inviter" } });
    mocks.mockRepositoryFindMany.mockImplementation(async (args: any) => {
      const ids = (args?.where?.id?.in as string[] | undefined) ?? [];
      return ids.map((id) => ({ id }));
    });
    mocks.mockVerifyInviterIsOwnerOrAdmin.mockResolvedValue({ ok: true });
    mocks.mockInvitationCreate.mockImplementation(async ({ data }) => ({
      id: "inv-1",
      ...data,
    }));
    mocks.mockPendingRepoAssignmentCreateMany.mockResolvedValue({ count: 1 });
  });

  it("requires authentication", async () => {
    mocks.mockRequireSession.mockRejectedValue(new Error("Unauthorized"));
    const res = await POST(makeReq({ email: "x@y.com", repoIds: ["r1"] }));
    expect(res.status).toBe(401);
  });

  it("requires an email", async () => {
    const res = await POST(makeReq({ repoIds: ["r1"] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Email is required");
  });

  it("requires at least one repoId", async () => {
    const res = await POST(makeReq({ email: "x@y.com", repoIds: [] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("At least one repo");
  });

  it("rejects when a selected repo is not found", async () => {
    mocks.mockRepositoryFindMany.mockResolvedValue([{ id: "r1" }]); // r2 missing
    const res = await POST(makeReq({ email: "x@y.com", repoIds: ["r1", "r2"] }));
    expect(res.status).toBe(400);
  });

  it("returns 403 when the inviter is not an owner/admin of a selected repo", async () => {
    mocks.mockVerifyInviterIsOwnerOrAdmin
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "not admin" });
    const res = await POST(makeReq({ email: "x@y.com", repoIds: ["r1", "r2"] }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("not admin");
  });

  it("creates the invitation and pending repo assignments on success", async () => {
    const res = await POST(
      makeReq({ email: "x@y.com", repoIds: ["r1", "r2"], role: "admin" }),
    );
    expect(res.status).toBe(200);
    expect(mocks.mockInvitationCreate).toHaveBeenCalled();
    expect(mocks.mockPendingRepoAssignmentCreateMany).toHaveBeenCalled();
  });

  it("passes the role to the invitation", async () => {
    await POST(
      makeReq({ email: "x@y.com", repoIds: ["r1"], role: "member" }),
    );
    const callArgs = mocks.mockInvitationCreate.mock.calls[0][0];
    expect(callArgs.data.role).toBe("member");
  });

  it("default role is admin (senior-dev handoff is the primary use case)", async () => {
    await POST(makeReq({ email: "x@y.com", repoIds: ["r1"] }));
    const callArgs = mocks.mockInvitationCreate.mock.calls[0][0];
    expect(callArgs.data.role).toBe("admin");
  });
});
