import { describe, it, expect, beforeEach } from "vitest";
import { backfillRepoOwners, type BackfillOptions } from "../scripts/backfill-repo-owners.mjs";

type RepoRow = { id: string; ownerId: string | null };
type UserRepoRow = { userId: string; repoId: string; role: string; invitedAt: Date; invitedById?: string | null };
type UserRow = { id: string; email: string };

function makeDb() {
  const repos = new Map<string, RepoRow>();
  const userRepos: UserRepoRow[] = [];
  const users = new Map<string, UserRow>();

  const db: BackfillOptions["prisma"] = {
    repository: {
      findMany: async (args: any) => {
        const rows = [...repos.values()];
        if (args?.where?.ownerId === null) {
          return rows.filter((r) => r.ownerId === null);
        }
        return rows;
      },
      update: async (args: any) => {
        const row = repos.get(args.where.id);
        if (!row) throw new Error("not found");
        row.ownerId = args.data.ownerId;
        return row;
      },
    },
    userRepo: {
      findMany: async (args: any) => {
        let rows = userRepos;
        if (args?.where?.repoId?.in) {
          rows = rows.filter((r) => args.where.repoId.in.includes(r.repoId));
        }
        if (args?.where?.role) {
          rows = rows.filter((r) => r.role === args.where.role);
        }
        if (args?.orderBy?.invitedAt === "asc") {
          rows = [...rows].sort((a, b) => a.invitedAt.getTime() - b.invitedAt.getTime());
        }
        return rows;
      },
      upsert: async (args: any) => {
        const idx = userRepos.findIndex(
          (r) => r.userId === args.where.userId_repoId.userId && r.repoId === args.where.userId_repoId.repoId,
        );
        if (idx >= 0) {
          return userRepos[idx];
        }
        const created: UserRepoRow = {
          userId: args.create.userId,
          repoId: args.create.repoId,
          role: args.create.role,
          invitedAt: new Date(),
          invitedById: args.create.invitedById ?? null,
        };
        userRepos.push(created);
        return created;
      },
    },
    user: {
      findFirst: async () => {
        const first = [...users.values()][0];
        return first ? { id: first.id } : null;
      },
    },
  };
  return { repos, userRepos, users, db };
}

describe("backfillRepoOwners", () => {
  let fixture: ReturnType<typeof makeDb>;

  beforeEach(() => {
    fixture = makeDb();
  });

  it("is a no-op when no repos exist", async () => {
    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.examined).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.userRepoUpserted).toBe(0);
  });

  it("is a no-op when every repo already has an owner (idempotency)", async () => {
    fixture.users.set("u1", { id: "u1", email: "a@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: "u1" });
    fixture.repos.set("r2", { id: "r2", ownerId: "u1" });

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.examined).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
  });

  it("assigns the first user when no UserRepo rows exist (dev-fresh path)", async () => {
    fixture.users.set("u1", { id: "u1", email: "first@example.com" });
    fixture.users.set("u2", { id: "u2", email: "second@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    fixture.repos.set("r2", { id: "r2", ownerId: null });

    const report = await backfillRepoOwners({ pick: "first-user", prisma: fixture.db });
    expect(report.examined).toBe(2);
    expect(report.updated).toBe(2);
    expect(fixture.repos.get("r1")!.ownerId).toBe("u1");
    expect(fixture.repos.get("r2")!.ownerId).toBe("u1");
  });

  it("picks the first admin UserRepo for each repo (multi-user path)", async () => {
    fixture.users.set("u1", { id: "u1", email: "owner@example.com" });
    fixture.users.set("u2", { id: "u2", email: "admin@example.com" });
    fixture.users.set("u3", { id: "u3", email: "member@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    // u2 was the first admin invited to r1, u3 is a member.
    fixture.userRepos.push(
      { userId: "u2", repoId: "r1", role: "admin", invitedAt: new Date("2026-01-01T00:00:00Z") },
      { userId: "u3", repoId: "r1", role: "member", invitedAt: new Date("2026-02-01T00:00:00Z") },
    );

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.examined).toBe(1);
    expect(report.updated).toBe(1);
    expect(fixture.repos.get("r1")!.ownerId).toBe("u2");
  });

  it("skips repos with no UserRepo rows in multi-user mode (leaves ownerId null)", async () => {
    fixture.users.set("u1", { id: "u1", email: "owner@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.examined).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(fixture.repos.get("r1")!.ownerId).toBeNull();
  });

  it("skips repos whose only UserRepo rows are members (no admin) in multi-user mode", async () => {
    fixture.users.set("u1", { id: "u1", email: "owner@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    fixture.userRepos.push(
      { userId: "u2", repoId: "r1", role: "member", invitedAt: new Date("2026-01-01T00:00:00Z") },
    );

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.examined).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(fixture.repos.get("r1")!.ownerId).toBeNull();
  });

  it("chooses the earliest admin by invitedAt when multiple admins exist for a repo", async () => {
    fixture.users.set("u1", { id: "u1", email: "owner@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    fixture.userRepos.push(
      { userId: "u2", repoId: "r1", role: "admin", invitedAt: new Date("2026-03-01T00:00:00Z") },
      { userId: "u3", repoId: "r1", role: "admin", invitedAt: new Date("2026-01-01T00:00:00Z") },
    );

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.updated).toBe(1);
    expect(fixture.repos.get("r1")!.ownerId).toBe("u3");
  });

  it("is idempotent: re-running leaves already-set rows alone", async () => {
    fixture.users.set("u1", { id: "u1", email: "first@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    fixture.repos.set("r2", { id: "r2", ownerId: "u1" });

    const first = await backfillRepoOwners({ pick: "first-user", prisma: fixture.db });
    expect(first.updated).toBe(1);
    expect(fixture.repos.get("r1")!.ownerId).toBe("u1");
    expect(fixture.repos.get("r2")!.ownerId).toBe("u1");

    const second = await backfillRepoOwners({ pick: "first-user", prisma: fixture.db });
    expect(second.examined).toBe(0);
    expect(second.updated).toBe(0);
  });

  it("mirrors the assigned owner as a UserRepo admin row (dev-fresh path)", async () => {
    fixture.users.set("u1", { id: "u1", email: "first@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    fixture.repos.set("r2", { id: "r2", ownerId: null });

    const report = await backfillRepoOwners({ pick: "first-user", prisma: fixture.db });
    expect(report.userRepoUpserted).toBe(2);
    const ur1 = fixture.userRepos.find((r) => r.repoId === "r1");
    const ur2 = fixture.userRepos.find((r) => r.repoId === "r2");
    expect(ur1).toMatchObject({ userId: "u1", role: "admin", invitedById: "u1" });
    expect(ur2).toMatchObject({ userId: "u1", role: "admin", invitedById: "u1" });
  });

  it("mirrors the assigned owner as a UserRepo admin row (multi-user path)", async () => {
    fixture.users.set("u2", { id: "u2", email: "admin@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    // Existing UserRepo admin row (would be the source of the first-admin pick).
    fixture.userRepos.push(
      { userId: "u2", repoId: "r1", role: "admin", invitedAt: new Date("2026-01-01T00:00:00Z"), invitedById: "u1" },
    );

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.userRepoUpserted).toBe(1);
    const ur1 = fixture.userRepos.find((r) => r.repoId === "r1");
    // The existing row is preserved (upsert with update: {} is a no-op on
    // the existing row). The invitedById stays as the original inviter.
    expect(ur1).toMatchObject({ userId: "u2", role: "admin", invitedById: "u1" });
  });

  it("does not duplicate the UserRepo row when one already exists (idempotent)", async () => {
    fixture.users.set("u2", { id: "u2", email: "admin@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });
    // Existing UserRepo admin row (would be the source of the first-admin pick).
    fixture.userRepos.push(
      { userId: "u2", repoId: "r1", role: "admin", invitedAt: new Date("2026-01-01T00:00:00Z"), invitedById: "u1" },
    );

    const before = fixture.userRepos.length;
    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.userRepoUpserted).toBe(1);
    expect(fixture.userRepos.length).toBe(before);
    const ur1 = fixture.userRepos.find((r) => r.repoId === "r1");
    expect(ur1?.invitedById).toBe("u1");
  });

  it("skips mirroring when no owner was assigned (multi-user with no admin)", async () => {
    fixture.users.set("u1", { id: "u1", email: "owner@example.com" });
    fixture.repos.set("r1", { id: "r1", ownerId: null });

    const report = await backfillRepoOwners({ pick: "first-admin", prisma: fixture.db });
    expect(report.userRepoUpserted).toBe(0);
    expect(fixture.userRepos.length).toBe(0);
  });
});
