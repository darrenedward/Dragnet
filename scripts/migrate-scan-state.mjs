#!/usr/bin/env node

/**
 * migrate-scan-state.mjs — Slice 2 scan state migration.
 *
 * Moves existing per-repo `.dragnet/{checkpoints,reports,reviews}`
 * directories into the centralised scan-state path at
 * `/var/lib/dragnet/scans/<repoId>/` (or `DRAGNET_SCAN_STATE_ROOT`).
 *
 * Usage:
 *   DRAGNET_DATABASE_URL="postgres://..." node scripts/migrate-scan-state.mjs
 *
 * Can also be run with `--dry-run` to preview without copying:
 *   node scripts/migrate-scan-state.mjs --dry-run
 *
 * What it does:
 *   1. Queries all repositories from the database.
 *   2. For each repo, checks if `<repo.path>/.dragnet/{checkpoints,reports,reviews}`
 *      exists.
 *   3. Copies (preserving mode 0600) to `<root>/<repoId>/`.
 *   4. On success, leaves originals in place — operator decides when to
 *      remove them after verifying the migration.
 *
 * Idempotent: if the target path already has files, they are left unchanged.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readFileSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");

const SCAN_STATE_ROOT = process.env.DRAGNET_SCAN_STATE_ROOT ?? "/var/lib/dragnet/scans";

function log(msg) {
  console.log(`[migrate-scan-state] ${msg}`);
}

function warn(msg) {
  console.warn(`[migrate-scan-state] WARN: ${msg}`);
}

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL
    ?? process.env.DRAGNET_DATABASE_URL
    ?? process.env.DB_URL;
  if (!url) {
    console.error(
      "ERROR: No DATABASE_URL found. Set DATABASE_URL, DRAGNET_DATABASE_URL, or DB_URL.",
    );
    process.exit(1);
  }
  return url;
}

async function queryRepos() {
  const url = getDatabaseUrl();
  const sql = `SELECT id, path, local_path FROM repositories`;
  const cmd = `psql -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}" "${url.replace(/"/g, '\\"')}"`;
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 30_000 });
    const lines = out.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const [id, path, localPath] = line.split("|").map((s) => s?.trim() || null);
      return { id, path, localPath };
    });
  } catch (err) {
    console.error("ERROR: Failed to query repositories:", err.message);
    return [];
  }
}

async function migrateRepo(repo) {
  const possiblePaths = [repo.localPath, repo.path].filter(Boolean);
  if (possiblePaths.length === 0) {
    warn(`Repo ${repo.id} has no path or localPath — skipping`);
    return;
  }

  const scanStateDir = join(SCAN_STATE_ROOT, repo.id);

  for (const repoPath of possiblePaths) {
    const dragnetDir = join(repoPath, ".dragnet");
    if (!existsSync(dragnetDir)) continue;

    const subdirs = ["checkpoints", "reports", "reviews"];
    for (const subdir of subdirs) {
      const src = join(dragnetDir, subdir);
      if (!existsSync(src)) continue;

      const dst = join(scanStateDir, subdir);
      if (existsSync(dst)) {
        log(`Target already exists: ${dst} — merging`);
      }

      copyRecursiveSync(src, dst, repo.id, subdir);
    }
  }
}

function copyRecursiveSync(src, dst, repoId, subdir) {
  if (!existsSync(src)) return;

  if (DRY_RUN) {
    log(`[dry-run] Would copy ${src} → ${dst}`);
    return;
  }

  mkdirSync(dst, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyRecursiveSync(srcPath, dstPath, repoId, subdir);
    } else if (entry.isFile()) {
      if (existsSync(dstPath)) {
        // Don't overwrite existing files — idempotent.
        continue;
      }
      try {
        copyFileSync(srcPath, dstPath);
        // Preserve mode from source if possible.
        try {
          const mode = statSync(srcPath).mode & 0o777;
          if (mode) {
            execSync(`chmod ${mode.toString(8)} "${dstPath}"`, { stdio: "ignore" });
          }
        } catch {
          // best-effort mode preservation
        }
      } catch (err) {
        warn(`Failed to copy ${srcPath} → ${dstPath}: ${err.message}`);
      }
    }
  }
}

async function main() {
  log(`Starting scan state migration (DRY_RUN=${DRY_RUN})`);
  log(`Scan state root: ${SCAN_STATE_ROOT}`);

  const repos = await queryRepos();
  log(`Found ${repos.length} repositories in the database`);

  if (repos.length === 0) {
    log("No repositories found — nothing to migrate.");
    return;
  }

  // Ensure the scan state root exists.
  if (!DRY_RUN && !existsSync(SCAN_STATE_ROOT)) {
    mkdirSync(SCAN_STATE_ROOT, { recursive: true });
    log(`Created scan state root: ${SCAN_STATE_ROOT}`);
  }

  let migrated = 0;
  for (const repo of repos) {
    const before = DRY_RUN ? 0 : countFilesUnder(join(SCAN_STATE_ROOT, repo.id));
    await migrateRepo(repo);
    const after = DRY_RUN ? 0 : countFilesUnder(join(SCAN_STATE_ROOT, repo.id));
    if (after > before) {
      migrated++;
      log(`Repo ${repo.id}: migrated ${after - before} files to ${join(SCAN_STATE_ROOT, repo.id)}`);
    } else {
      log(`Repo ${repo.id}: no new files migrated (already up to date or no source)`);
    }
  }

  log(`Migration complete. ${migrated}/${repos.length} repos had new state migrated.`);
  if (migrated > 0) {
    log("Originals left in place under their repo's .dragnet/ dir.");
    log("Once you verify the migration, remove the old directories manually:");
    log("  rm -rf <repo.path>/.dragnet/{checkpoints,reports,reviews}");
  }
}

function countFilesUnder(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) count++;
    }
  } catch {
    // ignore
  }
  return count;
}

main().catch((err) => {
  console.error("[migrate-scan-state] Fatal error:", err);
  process.exit(1);
});
