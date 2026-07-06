#!/usr/bin/env node
/**
 * Backfill repoId for existing Repository rows where it is null.
 *
 * Usage:
 *   node scripts/backfill-repoid.mjs        # dry-run
 *   node scripts/backfill-repoid.mjs --apply # apply changes
 *
 * What it does:
 *   1. SELECT repositories WHERE repoId IS NULL
 *   2. For repos with cloneUrl: compute repoId via computeRepoId(cloneUrl)
 *   3. For repos with localPath: compute repoId via computeLocalRepoId(localPath)
 *   4. For repos with neither: log a warning and skip
 *   5. Also compute and store canonicalRemote via canonicalizeUrl(cloneUrl)
 *   6. UPDATE the row with computed repoId and canonicalRemote
 *
 * Idempotent: skips rows that already have repoId set.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { createHash } from "node:crypto";

// Reimplemented functions from repoIdentity.ts (pure JS)
function stripAuth(path) {
  return path.includes("@") ? path.slice(path.lastIndexOf("@") + 1) : path;
}

function stripPort(host) {
  return host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
}

function stripTrailingGit(path) {
  return path.replace(/\.git$/, "");
}

function stripLeadingSlash(path) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function stripTrailingSlash(path) {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function canonicalizeUrl(remoteUrl) {
  if (!remoteUrl) {
    throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);
  }

  // SSH protocol: git@host:path
  const sshMatch = remoteUrl.match(/^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+):(.+)$/);
  if (sshMatch) {
    let host = sshMatch[2].toLowerCase();
    host = stripPort(host);
    let path = stripTrailingGit(sshMatch[3]).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  // HTTPS protocol: https://host/path
  const httpsMatch = remoteUrl.match(/^https:\/\/(.+)$/);
  if (httpsMatch) {
    const rest = httpsMatch[1];
    const atIdx = rest.lastIndexOf("@");
    const afterUserinfo = atIdx >= 0 ? rest.slice(atIdx + 1) : rest;
    const slashIdx = afterUserinfo.indexOf("/");
    let host = slashIdx >= 0 ? afterUserinfo.slice(0, slashIdx) : afterUserinfo;
    let path = slashIdx >= 0 ? afterUserinfo.slice(slashIdx + 1) : "";
    host = stripPort(host).toLowerCase();
    path = stripTrailingGit(path).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  // git:// protocol
  const gitMatch = remoteUrl.match(/^git:\/\/(.+)$/);
  if (gitMatch) {
    const rest = gitMatch[1];
    const slashIdx = rest.indexOf("/");
    let host = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    let path = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
    host = stripPort(host).toLowerCase();
    path = stripTrailingGit(path).toLowerCase();
    path = stripLeadingSlash(path);
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  // ssh:// protocol (ssh://git@host:port/path or ssh://host/path)
  const sshProtocolMatch = remoteUrl.match(/^ssh:\/\/(?:[^@]+@)?([^:/]+)(?::\d+)?\/(.+)$/);
  if (sshProtocolMatch) {
    let host = sshProtocolMatch[1].toLowerCase();
    let path = stripTrailingGit(sshProtocolMatch[2]).toLowerCase();
    path = stripTrailingSlash(path);
    return `https://${host}/${path}`;
  }

  throw new Error(`Cannot parse git remote URL: ${remoteUrl}`);
}

function computeRepoId(remoteUrl) {
  const canonical = canonicalizeUrl(remoteUrl);
  return canonical.replace(/^https:\/\//, "");
}

function computeLocalRepoId(localPath) {
  const hash = createHash("sha256").update(localPath).digest("hex");
  return `local/${hash.slice(0, 16)}`;
}

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
const stripped = cs
  .replace(/&?sslmode=[^&]*/gi, "")
  .replace(/\?&/, "?")
  .replace(/\?$/, "")
  .replace(/&&/g, "&");
const pool = new pg.Pool({
  connectionString: stripped,
  ssl: wantsNoSsl
    ? false
    : wantsStrictSsl
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function listReposNeedingBackfill() {
  const repos = await prisma.repository.findMany({
    where: { repoId: null },
    select: {
      id: true,
      name: true,
      cloneUrl: true,
      localPath: true,
      path: true,
    },
  });
  return repos;
}

async function backfillRepo(repo) {
  let repoId = null;
  let canonicalRemote = null;

  if (repo.cloneUrl) {
    try {
      canonicalRemote = canonicalizeUrl(repo.cloneUrl);
      repoId = computeRepoId(repo.cloneUrl);
    } catch (err) {
      console.error(
        `  !! Failed to compute repoId from cloneUrl "${repo.cloneUrl}": ${err.message}`,
      );
      return null;
    }
  } else if (repo.localPath) {
    repoId = computeLocalRepoId(repo.localPath);
  } else if (repo.path) {
    // Fall back to the old path field if localPath is null
    repoId = computeLocalRepoId(repo.path);
  } else {
    console.warn(
      `  ⚠ Repository "${repo.name}" (${repo.id}) has neither cloneUrl nor localPath/path — skipping`,
    );
    return null;
  }

  if (!APPLY) {
    console.log(`  Would update: repoId="${repoId}"${canonicalRemote ? `, canonicalRemote="${canonicalRemote}"` : ""}`);
    return { repoId, canonicalRemote };
  }

  const result = await prisma.repository.update({
    where: { id: repo.id },
    data: { repoId, canonicalRemote },
  });

  console.log(`  ✓ Updated ${repo.name} (${repo.id}): repoId="${repoId}"`);
  return result;
}

async function main() {
  const repos = await listReposNeedingBackfill();
  if (repos.length === 0) {
    console.log("No repositories with null repoId found — nothing to backfill.");
    return;
  }

  console.log(`Found ${repos.length} repositor(y/ies) with null repoId:`);
  for (const r of repos) {
    const source = r.cloneUrl
      ? `cloneUrl=${r.cloneUrl}`
      : r.localPath
        ? `localPath=${r.localPath}`
        : r.path
          ? `path=${r.path}`
          : "no source";
    console.log(`  ${r.name} (${r.id}) - ${source}`);
  }

  if (!APPLY) {
    console.log("\n(dry-run — re-run with --apply to execute)");
    console.log("\nPreview of changes:");
  } else {
    console.log("\nApplying...");
  }

  let updated = 0;
  let skipped = 0;
  for (const r of repos) {
    const result = await backfillRepo(r);
    if (result) {
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`\nDone. ${updated} repositor(y/ies) updated, ${skipped} skipped.`);

  // Sanity: confirm zero stragglers (only if we applied)
  if (APPLY) {
    const after = await listReposNeedingBackfill();
    if (after.length > 0) {
      console.warn(`Warning: ${after.length} repositor(y/ies) still have null repoId.`);
    }
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
