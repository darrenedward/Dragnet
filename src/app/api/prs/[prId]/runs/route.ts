import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: review runs expose scan metadata. proxy.ts is
  // cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { prId } = await params;
    const prScopeErr = await enforcePrRepoScope(auth, prId);
    if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });

    const runs = await prisma.reviewRun.findMany({
      where: { prId },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        rating: true,
        reliability: true,
        chunksTotal: true,
        chunksCompleted: true,
        chunksFailed: true,
        chunksSkipped: true,
        model: true,
        triggerReason: true,
        commitHash: true,
        forced: true,
        createdByUserId: true,
        createdByUser: { select: { id: true, name: true, email: true } },
      },
    });

    return NextResponse.json({ runs });
  } catch (err: any) {
    console.error("Failed to fetch review runs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
