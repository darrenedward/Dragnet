import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const key = await prisma.mcpApiKey.findUnique({ where: { id } });
  if (!key) {
    return NextResponse.json({ error: "API key not found." }, { status: 404 });
  }

  await prisma.mcpApiKey.update({
    where: { id },
    data: { revoked: true },
  });

  return NextResponse.json({ success: true });
}
