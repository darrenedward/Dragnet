import { NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";

/**
 * Lists directories under a given path. Used by the DirectoryPickerModal to
 * let users browse the filesystem visually instead of pasting paths by hand.
 *
 * Default base is os.homedir() — the user said "/home/user as base".
 *
 * Security: this runs locally only (the dev server is on the same machine
 * the user operates from). We do NOT expose file contents — just directory
 * names. Symlinks are followed but only their resolved target's `isDirectory`
 * is reported; broken symlinks are silently skipped.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");

  const target = rawPath && rawPath.trim() ? path.resolve(rawPath) : homedir();

  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return NextResponse.json(
        { success: false, error: "Path is not a directory." },
        { status: 400 },
      );
    }

    const entries = await readdir(target, { withFileTypes: true });
    const dirs: { name: string; path: string; isHidden: boolean }[] = [];

    for (const entry of entries) {
      // Skip obvious non-directories at the Dirent level.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const fullPath = path.join(target, entry.name);
      try {
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;
      } catch {
        // Broken symlink, permission denied, etc. — skip silently so a single
        // unreadable entry doesn't break the whole listing.
        continue;
      }

      dirs.push({
        name: entry.name,
        path: fullPath,
        isHidden: entry.name.startsWith("."),
      });
    }

    dirs.sort((a, b) => {
      // Visible directories first, then hidden — both alpha case-insensitive.
      if (a.isHidden !== b.isHidden) return a.isHidden ? 1 : -1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    const parent = path.dirname(target);

    return NextResponse.json({
      success: true,
      path: target,
      parent: parent === target ? null : parent,
      isHome: target === homedir(),
      entries: dirs,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.code === "ENOENT" ? "Path does not exist." : (err?.message || "Failed to read directory.") },
      { status: 400 },
    );
  }
}
