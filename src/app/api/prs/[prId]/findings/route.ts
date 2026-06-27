import { NextResponse } from "next/server";
import { getLatestCompletedReview } from "@/src/lib/reviewFreshness";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { prisma } from "@/src/lib/prisma";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";

/**
 * GET /api/prs/[prId]/findings
 *
 * Returns findings for the PR's latest completed ReviewRun (excluding
 * verifier-rejected findings) plus a freshness signal.
 *
 * - `reviewRun`: metadata about the run (commitHash, diffHash, completedAt,
 *   rating) so the UI can show "Reviewed commit: abc1234".
 * - `stale`: true when the PR's current PrFile diff doesn't match the
 *   run's recorded diffHash (i.e. the diff has moved since the review).
 * - `rejectedCount`: how many findings the verifier rejected — surfaced as
 *   a collapsible "Verifier filtered: N findings" section in the UI.
 *
 * If no completed run exists, returns an empty findings list with
 * `reviewRun: null` so the UI can render the "no review yet" state.
 */
export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: findings expose review content for the PR. proxy.ts
  // only checks cookie PRESENCE — validate the session against the DB.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { prId } = await params;

    const [latest, pr, files] = await Promise.all([
      getLatestCompletedReview(prId),
      prisma.pullRequest.findUnique({
        where: { id: prId },
        select: {
          sourceBranch: true,
          targetBranch: true,
          repository: { select: { path: true, baseBranch: true } },
        },
      }),
      prisma.prFile.findMany({
        where: { prId },
        select: { filename: true, additions: true, deletions: true },
      }),
    ]);
    const commitCount = pr
      ? readPrCommitCount(
          pr.repository.path,
          pr.targetBranch || pr.repository.baseBranch || "main",
          pr.sourceBranch,
        )
      : null;
    const sizeProfile = computePrSizeProfile(files, commitCount);
    const chunks = latest.reviewRun
      ? await prisma.reviewChunk.findMany({
          where: { reviewRunId: latest.reviewRun.id },
          orderBy: { id: "asc" },
          select: {
            id: true,
            label: true,
            filePaths: true,
            status: true,
            skipReason: true,
            rating: true,
            summary: true,
            errorMessage: true,
            lineCount: true,
            touchesSecuritySensitive: true,
            startedAt: true,
            completedAt: true,
          },
        })
      : [];

    if (!latest.reviewRun) {
      return NextResponse.json({
        reviewRun: null,
        findings: [],
        rejectedFindings: [],
        rejectedCount: 0,
        stale: false,
        sizeProfile,
        chunks,
        message: "No completed review yet. Run a scan.",
      });
    }

    return NextResponse.json({
      reviewRun: {
        id: latest.reviewRun.id,
        commitHash: latest.reviewRun.commitHash,
        diffHash: latest.reviewRun.diffHash,
        completedAt: latest.reviewRun.completedAt,
        rating: latest.reviewRun.rating,
        model: latest.reviewRun.model,
        triggerReason: latest.reviewRun.triggerReason,
        reliability: latest.reviewRun.reliability,
        chunksTotal: latest.reviewRun.chunksTotal,
        chunksCompleted: latest.reviewRun.chunksCompleted,
        chunksFailed: latest.reviewRun.chunksFailed,
        chunksSkipped: latest.reviewRun.chunksSkipped,
      },
      findings: latest.findings,
      rejectedFindings: latest.rejectedFindings,
      rejectedCount: latest.rejectedCount,
      stale: latest.stale,
      sizeProfile,
      chunks,
    });
  } catch (err: any) {
    console.error("Error fetching findings for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
