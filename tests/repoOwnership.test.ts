import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRepoUpdate: vi.fn(),
  mockUserRepoUpsert: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    repository: {
      update: mocks.mockRepoUpdate,
    },
    userRepo: {
      upsert: mocks.mockUserRepoUpsert,
    },
    $transaction: mocks.mockTransaction,
  },
}));

import { captureRepoOwnership } from "../src/lib/repoOwnership";

describe("captureRepoOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRepoUpdate.mockResolvedValue({});
    mocks.mockUserRepoUpsert.mockResolvedValue({});
    // $transaction in real Prisma accepts an array of promises and
    // resolves them atomically. Our mock just runs them in sequence.
    mocks.mockTransaction.mockImplementation(async (arg: unknown) => {
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      // Interactive callback form: run the callback with a tx-shaped object.
      return (arg as (tx: unknown) => Promise<unknown>)({
        repository: { update: mocks.mockRepoUpdate },
        userRepo: { upsert: mocks.mockUserRepoUpsert },
      });
    });
  });

  it("is a no-op when ownerId is null", async () => {
    await captureRepoOwnership("repo-1", null);
    expect(mocks.mockTransaction).not.toHaveBeenCalled();
    expect(mocks.mockRepoUpdate).not.toHaveBeenCalled();
    expect(mocks.mockUserRepoUpsert).not.toHaveBeenCalled();
  });

  it("wraps the repo update AND the UserRepo upsert in a single transaction", async () => {
    await captureRepoOwnership("repo-1", "user-1");
    expect(mocks.mockTransaction).toHaveBeenCalledTimes(1);
    const txArg = mocks.mockTransaction.mock.calls[0][0];
    expect(Array.isArray(txArg)).toBe(true);
    expect(txArg).toHaveLength(2);
  });

  it("writes ownerId on the repository inside the transaction", async () => {
    await captureRepoOwnership("repo-1", "user-1");
    expect(mocks.mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { ownerId: "user-1" },
    });
  });

  it("upserts a UserRepo admin row with invitedById = self-invite inside the transaction", async () => {
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

