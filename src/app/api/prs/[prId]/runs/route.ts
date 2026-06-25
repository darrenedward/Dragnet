import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ prId: string }> }) {
  try {
    const { prId } = await params;

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
        model: true,
        triggerReason: true,
        commitHash: true,
        forced: true,
      },
    });

    return NextResponse.json({ runs });
  } catch (err: any) {
    console.error("Failed to fetch review runs:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
