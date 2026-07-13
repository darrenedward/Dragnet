import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { prId } = await params;

  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { id: true },
    });
    if (!pr) return NextResponse.json({ error: "PR not found" }, { status: 404 });

    const [events, priorRunCount] = await Promise.all([
      prisma.bugFixEvent.findMany({
        where: { prId },
        orderBy: { fixedAt: "desc" },
        select: {
          id: true,
          filename: true,
          line: true,
          category: true,
          severity: true,
          fixedAt: true,
          fixedAtScanId: true,
          originatedAtScanId: true,
          sourceFindingId: true,
        },
      }),
      prisma.reviewRun.count({
        where: {
          prId,
          status: "completed",
          outcome: { not: "skipped" },
        },
      }),
    ]);

    return NextResponse.json(
      { fixedCount: events.length, events, hasPriorRun: priorRunCount > 1 },
      { headers: { "Cache-Control": "max-age=0, must-revalidate" } },
    );
  } catch (err) {
    console.error(`[fixes] failed to load fixes for prId=${prId}:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
