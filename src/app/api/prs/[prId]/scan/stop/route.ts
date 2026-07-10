import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { abortScan } from "@/src/lib/reviewLocks";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";

export async function POST(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { prId } = await params;
  const prScopeErr = await enforcePrRepoScope(auth, prId);
  if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });

  console.log(`[scan] stop: POST received for prId=${prId}`);

  // 1. Abort the in-memory controller (signals the running scan to stop).
  const aborted = abortScan(prId);

  // 2. Mark the active ReviewRun as failed in the DB so subsequent
  //    assertNoActiveScan doesn't see it as still in_progress.
  const activeRun = await prisma.reviewRun.findFirst({
    where: { prId, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (activeRun) {
    await prisma.reviewRun.update({
      where: { id: activeRun.id },
      data: { status: "failed", completedAt: new Date() },
    });
    console.log(`[scan] stop: ReviewRun ${activeRun.id} marked failed`);
  }

  // 3. Update PR status back to something sensible.
  await prisma.pullRequest.updateMany({
    where: { id: prId },
    data: { status: "Pending" },
  }).catch((e: unknown) => console.warn(`[scan] stop: failed to update PR status:`, e));

  return NextResponse.json({
    ok: true,
    stopped: aborted,
    message: aborted
      ? "Scan stopped."
      : "No active scan was running.",
  });
}
