// One-shot backfill for Repository.ownerId.
//
// Run with: npx tsx scripts/backfill-repo-owners.mts [--pick=first-admin]
//
// Idempotent. Two modes:
//
//   default: dev-fresh DB. Every null row is set to the first user
//     in the system. This is the right answer when there's only one
//     user — that user implicitly owns everything.
//
//   --pick=first-admin: multi-user prod DB. For each null row, pick
//     the user who holds a `UserRepo` row with `role = "admin"` for
//     that repo, ordered by `invitedAt asc`. If no such row exists,
//     leave the row alone — PR 2's create-time capture will fill it
//     when the next repo is registered, and existing repos with no
//     admin invite stay null until a human decides what to do.

export type BackfillReport = {
  examined: number;
  updated: number;
  skipped: number;
};

export type BackfillOptions = {
  pick: "first-user" | "first-admin";
  prisma: {
    repository: {
      findMany: (args: any) => Promise<Array<{ id: string; ownerId: string | null }>>;
      update: (args: any) => Promise<unknown>;
    };
    userRepo: {
      findMany: (args: any) => Promise<Array<{ userId: string; repoId: string; role: string; invitedAt: Date }>>;
    };
    user: {
      findFirst: (args: any) => Promise<{ id: string } | null>;
    };
  };
};

/**
 * Pure function — exposed for unit tests. Takes a prisma-shaped client
 * to keep the seam simple (no need to import @prisma/client in tests).
 * Finds every Repository where `ownerId` is null, then assigns an
 * owner based on `pick`.
 */
export async function backfillRepoOwners(
  options: BackfillOptions,
): Promise<BackfillReport> {
  const db = options.prisma;
  const nullRows = await db.repository.findMany({ where: { ownerId: null } });

  let updated = 0;
  let skipped = 0;

  if (options.pick === "first-admin") {
    // Multi-user path: per-repo, find the earliest admin UserRepo.
    // If none, leave the row alone.
    const repoIds = nullRows.map((r) => r.id);
    const adminRows = await db.userRepo.findMany({
      where: { repoId: { in: repoIds }, role: "admin" },
      orderBy: { invitedAt: "asc" },
    });
    const byRepo = new Map<string, string>();
    for (const row of adminRows) {
      if (!byRepo.has(row.repoId)) byRepo.set(row.repoId, row.userId);
    }
    for (const repo of nullRows) {
      const ownerId = byRepo.get(repo.id);
      if (!ownerId) {
        skipped++;
        continue;
      }
      await db.repository.update({ where: { id: repo.id }, data: { ownerId } });
      updated++;
    }
  } else {
    // Dev-fresh path: assign the first user to every null row.
    const first = await db.user.findFirst({ select: { id: true } });
    if (!first) {
      return { examined: nullRows.length, updated: 0, skipped: nullRows.length };
    }
    for (const repo of nullRows) {
      await db.repository.update({ where: { id: repo.id }, data: { ownerId: first.id } });
      updated++;
    }
  }

  return { examined: nullRows.length, updated, skipped };
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const pg = (await import("pg")).default;

  const args = new Set(process.argv.slice(2));
  const pickFirstAdmin = args.has("--pick=first-admin");
  const pick = pickFirstAdmin ? "first-admin" as const : "first-user" as const;

  const cs = process.env.DATABASE_URL;
  if (!cs) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
  const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
  const pool = new pg.Pool({
    connectionString: stripped,
    ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  console.log(`[backfill] mode = ${pick}`);
  const report = await backfillRepoOwners({ pick, prisma: prisma as any });
  console.log(`[backfill] examined=${report.examined} updated=${report.updated} skipped=${report.skipped}`);
  await prisma.$disconnect();
}

// Only run the CLI when invoked directly (not when imported by the test).
const isDirectInvocation =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("backfill-repo-owners.mts");
if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
}

