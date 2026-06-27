// One-off: rename greploop-* repoId → dragnet-* in place.
//
// Run dry-run first:
//   node scripts/migrate-repoid-to-dragnet.mjs
// Then apply:
//   node scripts/migrate-repoid-to-dragnet.mjs --apply
//
// What it does:
//   1. SELECT every repositories.id LIKE 'greploop-%'
//   2. For each, derive new id = 'dragnet-' + (id without the 'greploop-' prefix)
//   3. UPDATE children that carry repoId as a plain column (no FK) first:
//        review_runs, review_findings
//   4. Drop FK constraints that reference repositories(id) so we can move
//      the parent row's PK without RESTRICT. (Prisma FKs are ON UPDATE
//      NO ACTION — the default — so this step is required.)
//   5. UPDATE the FK-carrying children (review_history, pull_requests,
//      symbols, edges, files) to the new repoId.
//   6. UPDATE repositories.id itself.
//   7. Recreate the FK constraints with the same ON DELETE CASCADE semantics.
//
// Each repo migrates in its own transaction. If any step throws, the
// transaction rolls back and the script aborts — no half-migrated state.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

const cs = process.env.DATABASE_URL;
if (!cs) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const wantsNoSsl =
  Boolean(cs.match(/sslmode\s*=\s*(disable|allow|prefer)/i)) ||
  Boolean(
    cs.match(/@(localhost|127\.[\d.]+|::1|\[::1\]|[a-z0-9.-]+\.local)(:\d+)?\//i),
  );
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new pg.Pool({
  connectionString: stripped,
  ssl: wantsNoSsl
    ? false
    : wantsStrictSsl
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Tables with repoId columns. Partitioned by FK status:
//   - "plain" = just an indexed column, no FK to repositories(id)
//   - "fk"    = has FK to repositories(id), needs constraint drop/recreate
const PLAIN_REPOID_TABLES = ["review_runs", "review_findings"];
const FK_REPOID_TABLES = ["review_history", "pull_requests", "symbols", "edges", "files"];

// FK constraint names follow Prisma's convention: <table>_<column>_fkey
// These are the names Postgres assigned at creation time. Verify with:
//   SELECT conname FROM pg_constraint WHERE conrelid = '"<table>"'::regclass;
function fkName(table, column) {
  return `${table}_${column}_fkey`;
}

async function listGreploopRepos() {
  const repos = await prisma.repository.findMany({
    where: { id: { startsWith: "greploop-" } },
    select: { id: true, name: true },
  });
  return repos;
}

async function dropFkConstraints(client) {
  for (const t of FK_REPOID_TABLES) {
    const fkey = fkName(t, "repoId");
    await client.query(`ALTER TABLE "${t}" DROP CONSTRAINT IF EXISTS "${fkey}";`);
  }
}

async function recreateFkConstraints(client) {
  for (const t of FK_REPOID_TABLES) {
    const fkey = fkName(t, "repoId");
    await client.query(`
      ALTER TABLE "${t}"
        ADD CONSTRAINT "${fkey}"
        FOREIGN KEY ("repoId") REFERENCES repositories(id)
        ON DELETE CASCADE;
    `);
  }
}

async function migrateRepo(oldId, newId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await dropFkConstraints(client);

    // Plain-column children (no FK to worry about, but update them inside
    // the same transaction so a rollback covers everything).
    for (const t of PLAIN_REPOID_TABLES) {
      const res = await client.query(
        `UPDATE "${t}" SET "repoId" = $1 WHERE "repoId" = $2;`,
        [newId, oldId],
      );
      console.log(`  ${t}: ${res.rowCount} rows`);
    }

    // FK-carrying children — now safe because FK is dropped.
    for (const t of FK_REPOID_TABLES) {
      const res = await client.query(
        `UPDATE "${t}" SET "repoId" = $1 WHERE "repoId" = $2;`,
        [newId, oldId],
      );
      console.log(`  ${t}: ${res.rowCount} rows`);
    }

    // Parent last.
    const parentRes = await client.query(
      `UPDATE repositories SET id = $1 WHERE id = $2;`,
      [newId, oldId],
    );
    console.log(`  repositories: ${parentRes.rowCount} row (PK moved)`);

    await recreateFkConstraints(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // Try to restore FKs even if the txn rolled back — otherwise the
    // schema is left in a half-migrated state on a retry.
    try {
      await recreateFkConstraints(client);
    } catch (recreateErr) {
      console.error(`  !! FK recreation failed: ${recreateErr.message}`);
      console.error(`     Manual fix needed — inspect schema with \\d <table>`);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const repos = await listGreploopRepos();
  if (repos.length === 0) {
    console.log("No greploop-* repoIds found — nothing to migrate.");
    return;
  }

  console.log(`Found ${repos.length} repo(s) to migrate:`);
  for (const r of repos) {
    const suffix = r.id.slice("greploop-".length);
    const newId = `dragnet-${suffix}`;
    console.log(`  ${r.id}  →  ${newId}    (${r.name})`);
  }

  if (!APPLY) {
    console.log("\n(dry-run — re-run with --apply to execute)");
    return;
  }

  console.log("\nApplying...");
  for (const r of repos) {
    const suffix = r.id.slice("greploop-".length);
    const newId = `dragnet-${suffix}`;
    console.log(`\n[${r.id} → ${newId}]`);
    try {
      await migrateRepo(r.id, newId);
      console.log(`  ✓ committed`);
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}`);
      console.error(`     Rolled back. Stopping.`);
      process.exit(1);
    }
  }

  // Sanity: confirm zero stragglers.
  const after = await listGreploopRepos();
  console.log(`\nDone. ${after.length} greploop-* repoId(s) remaining.`);
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
