import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRepoUpdate: vi.fn(),
  mockUserRepoUpsert: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      update: mocks.mockRepoUpdate,
    },
    userRepo: {
      upsert: mocks.mockUserRepoUpsert,
    },
  },
}));

import { captureRepoOwnership } from "../src/lib/repoOwnership";

describe("captureRepoOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRepoUpdate.mockResolvedValue({});
    mocks.mockUserRepoUpsert.mockResolvedValue({});
  });

  it("is a no-op when ownerId is null", async () => {
    await captureRepoOwnership("repo-1", null);
    expect(mocks.mockRepoUpdate).not.toHaveBeenCalled();
    expect(mocks.mockUserRepoUpsert).not.toHaveBeenCalled();
  });

  it("writes ownerId on the repository", async () => {
    await captureRepoOwnership("repo-1", "user-1");
    expect(mocks.mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { ownerId: "user-1" },
    });
  });

  it("upserts a UserRepo admin row with invitedById = self-invite", async () => {
    await captureRepoOwnership("repo-1", "user-1");
    expect(mocks.mockUserRepoUpsert).toHaveBeenCalledWith({
      where: { userId_repoId: { userId: "user-1", repoId: "repo-1" } },
      create: {
        userId: "user-1",
        repoId: "repo-1",
        role: "admin",
        invitedById: "user-1",
      },
      update: {},
    });
  });

  it("does not error if the UserRepo row already exists (idempotent)", async () => {
    mocks.mockUserRepoUpsert.mockResolvedValue({ id: "ur-existing" });
    await captureRepoOwnership("repo-1", "user-1");
    // upsert was called with update: {} — no-op on the existing row
    expect(mocks.mockUserRepoUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });
});
