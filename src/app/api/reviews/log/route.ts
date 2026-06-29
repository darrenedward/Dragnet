import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // Route-level auth: review logs contain operator trace + LLM responses.
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { searchParams } = new URL(req.url);
    const prId = searchParams.get("prId");
    const reviewRunId = searchParams.get("reviewRunId");

    if (!prId && !reviewRunId) {
      return NextResponse.json(
        { error: "Missing prId or reviewRunId query parameter" },
        { status: 400 }
      );
    }

    const where = reviewRunId ? { reviewRunId } : { prId };

    // Fetch the NEWEST 200 (desc), then reverse in memory so the response
    // stays chronological (asc) for the UI. The previous asc+take returned
    // the OLDEST 200 — once a scan crossed 200 log rows the polling
    // signature never changed and the UI froze, hiding live errors like
    // 429s that landed in rows 201+.
    const logs = await prisma.reviewLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, message: true, level: true, createdAt: true, reviewRunId: true, reviewChunkId: true },
    });

    return NextResponse.json(logs.reverse());
  } catch (err: any) {
    console.error("Failed to fetch review logs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
