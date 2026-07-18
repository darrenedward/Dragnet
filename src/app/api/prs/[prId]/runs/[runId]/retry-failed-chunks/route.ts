import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";
import { admitScanJobForPr } from "@/src/services/scanQueue";

export const runtime = "nodejs";

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

    const job = await admitScanJobForPr({
      prId,
      triggerReason: `retry-failed-chunks:${runId}`,
      forced: true,
      createdByUserId: auth.userId,
    });
    if (!job) return NextResponse.json({ error: "Pull request not found." }, { status: 404 });
    return NextResponse.json({ ok: true, accepted: true, jobId: job.jobId, state: job.state, queuePosition: job.queuePosition }, { status: 202 });
  } catch (err: any) {
    console.error("Failed to retry Large PR chunks:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
