import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const symbols = await prisma.symbol.findMany({ where: { repoId: id } });
    const safe = symbols.map((s) => ({
      ...s,
      summaryAt: s.summaryAt != null ? s.summaryAt.toString() : null,
    }));
    return NextResponse.json(safe);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
