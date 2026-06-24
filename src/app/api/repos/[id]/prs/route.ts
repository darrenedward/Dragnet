import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getRealLocalPrs } from "@/src/lib/getRealLocalPrs";

/**
 * Map of in-flight refresh promises keyed by repo ID. Prevents the
 * stale-delete / upsert gap in getRealLocalPrs() from being observed
 * by concurrent readers: every GET that arrives while a refresh is
 * in progress waits for the same promise, then reads a consistent
 * snapshot. Lives only in this dev server process.
 */
const refreshPromises = new Map<string, Promise<any>>();

/**
 * Returns the current PR list for a repo. Ensures the git-based PR
 * scan runs at most once concurrently per repo — all callers during
 * the scan wait for the same result, so no one observes the partial
 * state inside getRealLocalPrs()'s delete-then-upsert update.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    // Fire-and-forget: return current DB state immediately, refresh in background.
    if (repo.path && !refreshPromises.has(id)) {
      refreshPromises.set(id,
        getRealLocalPrs(repo.path, id)
          .catch((err) => console.warn(`Background PR refresh failed for ${id}:`, err))
          .finally(() => refreshPromises.delete(id))
      );
    }

    const prs = await prisma.pullRequest.findMany({
      where: { repoId: id },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(prs);
  } catch (err: any) {
    console.error("Error fetching repository PRs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Force a rescan and wait for it. Used by the manual "refresh" button
 * when the user wants the freshest possible state.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    if (repo.path) await getRealLocalPrs(repo.path, id);

    const prs = await prisma.pullRequest.findMany({
      where: { repoId: id },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(prs);
  } catch (err: any) {
    console.error("Error refreshing repository PRs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
