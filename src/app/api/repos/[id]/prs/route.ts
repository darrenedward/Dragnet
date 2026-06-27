import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getRealLocalPrs } from "@/src/lib/getRealLocalPrs";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";

/**
 * Map of in-flight refresh promises keyed by repo ID. Prevents the
 * stale-delete / upsert gap in getRealLocalPrs() from being observed
 * by concurrent readers: every GET that arrives while a refresh is
 * in progress waits for the same promise, then reads a consistent
 * snapshot. Lives only in this dev server process.
 */
const refreshPromises = new Map<string, Promise<any>>();

async function attachSizeProfiles(prs: any[], repo: { path: string | null; baseBranch: string | null }) {
  if (prs.length === 0) return prs;
  const prIds = prs.map((p) => p.id);
  const files = await prisma.prFile.findMany({
    where: { prId: { in: prIds } },
    select: { prId: true, filename: true, additions: true, deletions: true },
  });
  const filesByPr = new Map<string, typeof files>();
  for (const file of files) {
    const current = filesByPr.get(file.prId) || [];
    current.push(file);
    filesByPr.set(file.prId, current);
  }

  return prs.map((pr) => {
    const baseBranch = pr.targetBranch || repo.baseBranch || "main";
    const commitCount = readPrCommitCount(repo.path, baseBranch, pr.sourceBranch);
    return {
      ...pr,
      sizeProfile: computePrSizeProfile(filesByPr.get(pr.id) || [], commitCount),
    };
  });
}

/**
 * Returns the current PR list for a repo. Ensures the git-based PR
 * scan runs at most once concurrently per repo — all callers during
 * the scan wait for the same result, so no one observes the partial
 * state inside getRealLocalPrs()'s delete-then-upsert update.
 *
 * Merged PRs are excluded by default — they cluttered the active
 * review queue with already-shipped work. Pass ?include_merged=true
 * for an archived view.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: PR list is operator-private. proxy.ts is cookie-
  // PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
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

    const includeMerged = new URL(req.url).searchParams.get("include_merged") === "true";
    const prs = await prisma.pullRequest.findMany({
      where: includeMerged
        ? { repoId: id }
        : { repoId: id, status: { not: "Merged" } },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(await attachSizeProfiles(prs, repo));
  } catch (err: any) {
    console.error("Error fetching repository PRs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Force a rescan and wait for it. Used by the manual "refresh" button
 * when the user wants the freshest possible state.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: force-refresh is a write-ish op (re-runs git scan).
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    if (repo.path) await getRealLocalPrs(repo.path, id);

    const includeMerged = new URL(req.url).searchParams.get("include_merged") === "true";
    const prs = await prisma.pullRequest.findMany({
      where: includeMerged
        ? { repoId: id }
        : { repoId: id, status: { not: "Merged" } },
      orderBy: { createdAt: 'desc' }
    });
    return NextResponse.json(await attachSizeProfiles(prs, repo));
  } catch (err: any) {
    console.error("Error refreshing repository PRs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
