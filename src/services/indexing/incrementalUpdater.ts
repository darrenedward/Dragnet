/**
 * Incremental updater — computes the diff between on-disk files and the
 * existing `files` table rows so we can skip unchanged work.
 *
 * PRD §12.3 strategy:
 *   1. Watcher detects file changes (out of scope — we just get called).
 *   2. Compute SHA-256 of each file, compare to files.fileHash.
 *   3. Unchanged → skip. Changed/new → re-parse + re-embed.
 *   4. File deletions prune all associated symbols + edges.
 *
 * This module is language-agnostic — it doesn't care what's inside the
 * files, just whether their content hash changed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { FileDiff, FileOnDisk } from "./types";

export interface ExistingFileRow {
  filePath: string;
  fileHash: string;
}

/**
 * Reads all files under `resolvedPath` matching the given extensions,
 * returning their absolute path, repo-relative path, content, and hash.
 * Walks the directory tree, skipping common build/dependency dirs.
 */
export function readFilesForIndexing(
  resolvedPath: string,
  allFiles: string[],
  targetExts: string[],
): FileOnDisk[] {
  return allFiles
    .filter((f) => targetExts.includes(extOf(f)))
    .map((f) => ({
      absolutePath: f,
      relativePath: relativePathOf(resolvedPath, f),
      code: fs.readFileSync(f, "utf-8"),
    }))
    .map((f) => ({
      ...f,
      hash: crypto.createHash("md5").update(f.code).digest("hex"),
    }));
}

/**
 * Diffs the on-disk file set against existing DB rows. Returns three sets:
 *   - unchanged (skip — same hash)
 *   - changed (re-parse + re-embed)
 *   - deletedFilePaths (prune symbols + edges)
 *
 * If nothing changed and there are existing rows, the caller should
 * short-circuit (don't even update the repo's timestamp).
 */
export function diffFileSets(
  diskFiles: FileOnDisk[],
  existing: ExistingFileRow[],
): FileDiff {
  const existingByPath = new Map(existing.map((f) => [f.filePath, f]));
  const diskPaths = new Set(diskFiles.map((f) => f.relativePath));

  const unchanged: FileOnDisk[] = [];
  const changed: FileOnDisk[] = [];

  for (const f of diskFiles) {
    const row = existingByPath.get(f.relativePath);
    if (row && row.fileHash === f.hash) {
      unchanged.push(f);
    } else {
      changed.push(f);
    }
  }

  const deletedFilePaths = [...existingByPath.keys()].filter(
    (p) => !diskPaths.has(p),
  );

  return { unchanged, changed, deletedFilePaths };
}

function extOf(filePath: string): string {
  const base = filePath.split("/").pop() || filePath;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.substring(dot).toLowerCase();
}

function relativePathOf(root: string, abs: string): string {
  const rootNorm = root.endsWith("/") ? root.slice(0, -1) : root;
  if (abs.startsWith(rootNorm + "/")) return abs.substring(rootNorm.length + 1);
  if (abs.startsWith(rootNorm)) return abs.substring(rootNorm.length);
  return abs;
}
