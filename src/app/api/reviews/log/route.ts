import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: Request) {
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

    const logs = await prisma.reviewLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, message: true, level: true, createdAt: true, reviewRunId: true },
    });

    return NextResponse.json(logs);
  } catch (err: any) {
    console.error("Failed to fetch review logs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
