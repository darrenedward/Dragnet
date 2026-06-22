import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { generateApiKey } from "@/src/lib/mcpAuth";

export async function GET() {
  const keys = await prisma.mcpApiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revoked: true },
  });
  return NextResponse.json(keys);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Name is required to label this key." }, { status: 400 });
  }

  const { raw, prefix, hash } = generateApiKey();

  await prisma.mcpApiKey.create({
    data: { name, prefix, hash },
  });

  return NextResponse.json({
    key: raw,
    prefix,
    name,
    message: "Copy this key now — it won't be shown again.",
  });
}
