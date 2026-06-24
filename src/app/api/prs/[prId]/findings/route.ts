import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { computeDiffHash } from "@/src/lib/reviewFreshness";

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
export async function GET(_req: Request, { params }: { params: Promise<{ prId: string }> }) {
  try {
    const { prId } = await params;

    const latestRun = await prisma.reviewRun.findFirst({
      where: { prId, status: "completed" },
      orderBy: { completedAt: "desc" },
      select: {
        id: true,
        commitHash: true,
        diffHash: true,
        reviewConfigHash: true,
        completedAt: true,
        rating: true,
        model: true,
        triggerReason: true,
      },
    });

    if (!latestRun) {
      return NextResponse.json({
        reviewRun: null,
        findings: [],
        rejectedCount: 0,
        stale: false,
        message: "No completed review yet. Run a scan.",
      });
    }

    // Drift check: hash the PR's current PrFile diffs and compare to the
    // run's recorded diffHash. If they differ, the UI shows a ⚠ stale chip.
    const prFiles = await prisma.prFile.findMany({
      where: { prId },
      select: { filename: true, diff: true },
    });
    const currentDiffHash = computeDiffHash(prFiles);
    const stale = latestRun.diffHash !== "" && latestRun.diffHash !== currentDiffHash;

    const [findings, rejectedCount] = await Promise.all([
      prisma.reviewFinding.findMany({
        where: { reviewRunId: latestRun.id, verificationStatus: { not: "rejected" } },
        select: {
          id: true,
          category: true,
          severity: true,
          filename: true,
          line: true,
          explanation: true,
          diffSuggestion: true,
          evidenceChain: true,
          confidence: true,
          verificationStatus: true,
          verificationNote: true,
          timestamp: true,
        },
        orderBy: { line: "asc" },
      }),
      prisma.reviewFinding.count({
        where: { reviewRunId: latestRun.id, verificationStatus: "rejected" },
      }),
    ]);

    return NextResponse.json({
      reviewRun: {
        id: latestRun.id,
        commitHash: latestRun.commitHash,
        diffHash: latestRun.diffHash,
        completedAt: latestRun.completedAt,
        rating: latestRun.rating,
        model: latestRun.model,
        triggerReason: latestRun.triggerReason,
      },
      findings,
      rejectedCount,
      stale,
    });
  } catch (err: any) {
    console.error("Error fetching findings for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
