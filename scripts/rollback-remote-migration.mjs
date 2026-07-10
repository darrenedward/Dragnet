#!/usr/bin/env node
/**
 * rollback-remote-migration.mjs
 *
 * One-shot rollback of migrate-repos-to-remote.mjs. Restores the
 * `/host-repos/<name>` path on every repo that was migrated so the
 * existing local-mode code paths (which read `repo.path` directly)
 * keep working under `docker compose up -d` with the `/host-repos`
 * bind mount.
 *
 * Use this if the remote-mode refactor isn't done yet and you need
 * the local dev workflow back.
 */

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const cs = process.env.DATABASE_URL;
if (!cs) { console.error("DATABASE_URL is not set"); process.exit(1); }

const stripped = cs
  .replace(/&?sslmode=[^&]*/gi, "")
  .replace(/\?&/, "?")
  .replace(/\?$/, "")
  .replace(/&&/g, "&");
const pool = new Pool({ connectionString: stripped, ssl: false });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const repos = await prisma.repository.findMany({
  where: {
    cloneUrl: { not: null },
    path: null,
    OR: [
      { deployKeyCipher: { not: null } },
      { patCipher: { not: null } },
    ],
  },
  select: { id: true, name: true, cloneUrl: true },
});

if (repos.length === 0) {
  console.log("No migrated repos to roll back.");
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}

console.log(`Rolling back ${repos.length} repo(s) to local-path mode:\n`);

for (const repo of repos) {
  // Best-effort: derive the same /host-repos/<name> path the original
  // setup used. The migration stored cloneUrl = `git@github.com:<owner>/<repo>.git`
  // so the segment after the last `/` (without `.git`) is the name.
  const m = (repo.cloneUrl || "").match(/[:/]([^/:]+?)(?:\.git)?$/);
  const name = m ? m[1] : repo.id;
  const restoredPath = `/host-repos/${name}`;

  await prisma.repository.update({
    where: { id: repo.id },
    data: {
      path: restoredPath,
      deployKeyCipher: null,
      deployKeyIv: null,
      deployKeyTag: null,
      patCipher: null,
      patIv: null,
      patTag: null,
    },
  });

  console.log(`  [ok] ${repo.name} -> path=${restoredPath} (auth cleared)`);
}

console.log("\nDone. Re-add the /host-repos mount to docker-compose.yml if removed, then 'docker compose up -d'.\n");
await prisma.$disconnect();
await pool.end();