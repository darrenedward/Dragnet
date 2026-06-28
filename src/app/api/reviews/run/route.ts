import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export const runtime = "nodejs";

/**
 * GET /api/reviews/run?reviewRunId=X
 *
 * Returns the full findings payload for an arbitrary ReviewRun — used by
 * ScanHistory to render a prior scan's findings (not just logs) when the
 * user expands a historical row. Mirrors the shape of
 * /api/prs/[prId]/findings so the UI can reuse the same rendering logic.
 *
 * Findings are split into visible (verifier-accepted or unverified) and
 * rejected (verifier-rejected with a note), matching the live panel.
 */
export async function GET(req: Request) {
  // Route-level auth: exposes full review findings for any reviewRunId.
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { searchParams } = new URL(req.url);
    const reviewRunId = searchParams.get("reviewRunId");

    if (!reviewRunId) {
      return NextResponse.json(
        { error: "Missing reviewRunId query parameter" },
        { status: 400 },
      );
    }

    const run = await prisma.reviewRun.findUnique({
      where: { id: reviewRunId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        rating: true,
        reliability: true,
        refused: true,
        refusalNote: true,
        chunksTotal: true,
        chunksCompleted: true,
        chunksFailed: true,
        chunksSkipped: true,
        model: true,
        triggerReason: true,
        commitHash: true,
        forced: true,
      },
    });

    if (!run) {
      return NextResponse.json(
        { error: "Review run not found" },
        { status: 404 },
      );
    }

    const [findings, rejectedFindings, chunks] = await Promise.all([
      prisma.reviewFinding.findMany({
        where: {
          reviewRunId: run.id,
          OR: [
            { verificationStatus: null },
            { verificationStatus: { not: "rejected" } },
          ],
        },
        orderBy: { line: "asc" },
        select: {
          id: true,
          filename: true,
          line: true,
          severity: true,
          category: true,
          explanation: true,
          diffSuggestion: true,
          evidenceChain: true,
          confidence: true,
          verificationStatus: true,
          verificationNote: true,
          source: true,
        },
      }),
      prisma.reviewFinding.findMany({
        where: { reviewRunId: run.id, verificationStatus: "rejected" },
        orderBy: { line: "asc" },
        select: {
          id: true,
          filename: true,
          line: true,
          severity: true,
          category: true,
          explanation: true,
          verificationNote: true,
          source: true,
        },
      }),
      prisma.reviewChunk.findMany({
        where: { reviewRunId: run.id },
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
      }),
    ]);

    return NextResponse.json({
      reviewRun: run,
      findings,
      rejectedFindings,
      rejectedCount: rejectedFindings.length,
      chunks,
    });
  } catch (err: any) {
    console.error("Failed to fetch review run:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
