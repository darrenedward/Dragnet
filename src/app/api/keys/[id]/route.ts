import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) {
    return NextResponse.json({ error: "API key not found." }, { status: 404 });
  }

  await prisma.apiKey.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
