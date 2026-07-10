import { NextResponse } from "next/server";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getScanStatePath } from "@/src/lib/scanStatePath";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";
import {
  buildReviewMarkdown,
  sanitizeBranchSlug,
  type ExportFile,
  type ExportFinding,
} from "@/src/lib/exportReviewMarkdown";

export const runtime = "nodejs";

/**
 * POST /api/prs/[prId]/runs/[runId]/export-markdown
 * Body: { format: "file" | "download" }
 *
 *  - file: atomically writes the markdown to
 *    `.dragnet/reviews/<prSlug>/<runId>.md` and returns `{ ok, path, slug }`.
 *  - download: returns the markdown inline as `{ ok, markdown, filename }`
 *    so the client can wrap in a Blob and trigger a download. This is the
 *    legacy browser-download path, kept as a secondary action.
 *
 * Auth: session OR API key (matches retry-failed-chunks sibling).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ prId: string; runId: string }> },
) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { prId, runId } = await params;
  const prScopeErr = await enforcePrRepoScope(auth, prId);
  if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });
  try {
    const run = await prisma.reviewRun.findUnique({
      where: { id: runId },
      select: {
        completedAt: true,
        model: true,
        repoId: true,
        commitHash: true,
        pullRequest: {
          select: {
            id: true,
            title: true,
            sourceBranch: true,
            targetBranch: true,
            author: true,
            commitHash: true,
          },
        },
        reviewFindings: {
          select: {
            severity: true,
            category: true,
            filename: true,
            line: true,
            explanation: true,
            diffSuggestion: true,
          },
        },
      },
    });
    if (!run || run.pullRequest.id !== prId) {
      return NextResponse.json({ error: "Review run not found for this PR." }, { status: 404 });
    }
    const repo = await prisma.repository.findUnique({
      where: { id: run.repoId },
      select: { id: true, name: true, path: true },
    });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found." }, { status: 404 });
    }

    // Pull the diff files. Stored as PrFile rows keyed on prId.
    const prFiles = await prisma.prFile.findMany({
      where: { prId },
      select: { filename: true, additions: true, deletions: true },
    });
    const files: ExportFile[] = prFiles.map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
    }));

    const findings: ExportFinding[] = run.reviewFindings.map((f) => ({
      severity: f.severity,
      category: f.category,
      filename: f.filename,
      line: f.line ?? "",
      explanation: f.explanation,
      diffSuggestion: f.diffSuggestion,
    }));

    const markdown = buildReviewMarkdown({
      repoName: repo.name,
      prTitle: run.pullRequest.title,
      sourceBranch: run.pullRequest.sourceBranch,
      targetBranch: run.pullRequest.targetBranch,
      commitHash: run.pullRequest.commitHash || run.commitHash,
      author: run.pullRequest.author,
      runId,
      scannedAt: run.completedAt ?? undefined,
      files,
      findings,
    });

    const slug = sanitizeBranchSlug(run.pullRequest.sourceBranch) || "untitled";
    const filename = `${runId}.md`;

    const body = await req.json().catch(() => ({}));
    const format = (body && typeof body === "object" && "format" in body)
      ? (body as { format: string }).format
      : "file";

    if (format === "download") {
      return NextResponse.json({
        ok: true,
        format: "download",
        markdown,
        filename: `${slug}-${filename}`,
      });
    }

    // Write into the central scan-state path, not the Dragnet install's.
    // Slice 2: uses repo.id so artifacts land in the centralised scan state
    // directory (/var/lib/dragnet/scans/<repoId>/reviews/<slug>/<runId>.md)
    // instead of per-repo .dragnet/ dirs.
    const reviewsDir = join(getScanStatePath(repo.id ?? ""), "reviews", slug);
    const finalPath = join(reviewsDir, filename);
    const tmpPath = `${finalPath}.tmp`;
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(tmpPath, markdown, { mode: 0o600 });
    await rename(tmpPath, finalPath);

    return NextResponse.json({
      ok: true,
      format: "file",
      path: finalPath,
      slug,
      filename,
      relPath: `reviews/${slug}/${filename}`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
