import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRepositoryFindUnique: vi.fn(),
  mockUserRepoFindUnique: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.mockRepositoryFindUnique,
    },
    userRepo: {
      findUnique: mocks.mockUserRepoFindUnique,
    },
  },
}));

import { verifyInviterIsOwnerOrAdmin } from "../src/lib/apiAuth";

describe("verifyInviterIsOwnerOrAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when the user is the owner of the repo", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      ownerId: "user-1",
    });
    mocks.mockUserRepoFindUnique.mockResolvedValue(null);
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-1");
    expect(result.ok).toBe(true);
  });

  it("returns ok when the user has a UserRepo row with role=admin", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      ownerId: "user-owner",
    });
    mocks.mockUserRepoFindUnique.mockResolvedValue({
      userId: "user-1",
      repoId: "repo-1",
      role: "admin",
    });
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-1");
    expect(result.ok).toBe(true);
  });

  it("returns not-ok when the user has a UserRepo row with role=member", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      ownerId: "user-owner",
    });
    mocks.mockUserRepoFindUnique.mockResolvedValue({
      userId: "user-1",
      repoId: "repo-1",
      role: "member",
    });
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/admin/);
  });

  it("returns not-ok when the user has no UserRepo row and is not the owner", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      ownerId: "user-owner",
    });
    mocks.mockUserRepoFindUnique.mockResolvedValue(null);
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns not-ok when the repo does not exist", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue(null);
    mocks.mockUserRepoFindUnique.mockResolvedValue(null);
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-missing");
    expect(result.ok).toBe(false);
  });

  it("treats owner=null repo as 'no owner' (the other branch — UserRepo) is still the gate", async () => {
    mocks.mockRepositoryFindUnique.mockResolvedValue({
      id: "repo-1",
      ownerId: null,
    });
    mocks.mockUserRepoFindUnique.mockResolvedValue(null);
    const result = await verifyInviterIsOwnerOrAdmin("user-1", "repo-1");
    expect(result.ok).toBe(false);
  });
});
