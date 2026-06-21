import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan } from "@/reviewService";

/**
 * Triggers an AI review scan on a PR.
 *
 * Hard-gate: refuses with 409 INDEX_REQUIRED if the PR's repository has
 * never been indexed (`indexedAt` is null). Reviewing without an index
 * silently degraded to diff-only LLM guesses (or, with no LLM configured,
 * literal hardcoded fake findings from generateRealisticFindings) — both
 * worse than no review at all. See prd.md:194-196 for the index-first
 * contract.
 */
export async function POST(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  const { prId } = await params;
  await req.json().catch(() => ({}));

  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { repoId: true },
    });
    if (!pr) {
      return NextResponse.json({ error: "PR not found." }, { status: 404 });
    }

    const repo = await prisma.repository.findUnique({
      where: { id: pr.repoId },
      select: { indexedAt: true, name: true },
    });
    if (!repo) {
      return NextResponse.json({ error: "Repository record not found." }, { status: 404 });
    }
    if (!repo.indexedAt) {
      return NextResponse.json(
        {
          error: "INDEX_REQUIRED",
          message: `Project "${repo.name}" has not been indexed yet. Index the codebase first (Codebase AST graph tab → Re-index), then run the review.`,
          repoId: pr.repoId,
        },
        { status: 409 },
      );
    }

    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
    await new Promise(resolve => setTimeout(resolve, 800));

    const result = await runPrScan(prId);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Scan processing failed:", err);
    try {
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'Failed' } });
    } catch (dbErr) {
      console.error("Failed to mark PR status as Failed:", dbErr);
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
