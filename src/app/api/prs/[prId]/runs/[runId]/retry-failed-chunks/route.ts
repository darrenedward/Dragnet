import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";
import { acquireReviewLock, endReview } from "@/src/lib/reviewLocks";
import { retryFailedChunks } from "@/src/services/largePrReview";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ prId: string; runId: string }> },
) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { prId, runId } = await params;
  let acquired = false;
  try {
    const run = await prisma.reviewRun.findUnique({
      where: { id: runId },
      select: { prId: true },
    });
    if (!run || run.prId !== prId) {
      return NextResponse.json({ error: "Review run not found for this PR." }, { status: 404 });
    }

    const resumableCount = await prisma.reviewChunk.count({
      where: { reviewRunId: runId, status: { in: ["failed", "pending", "running"] } },
    });
    if (resumableCount === 0) {
      return NextResponse.json({ ok: true, message: "Nothing to resume — all chunks completed or skipped." });
    }

    const lock = await acquireReviewLock(prId, false);
    if (lock.status === "busy") {
      return NextResponse.json(
        {
          error: "SCAN_IN_PROGRESS",
          runId: lock.runId,
          startedAt: lock.startedAt,
          message: lock.message,
        },
        { status: 409 },
      );
    }
    acquired = true;

    const result = await retryFailedChunks(runId);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Failed to retry Large PR chunks:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  } finally {
    if (acquired) endReview(prId);
  }
}
