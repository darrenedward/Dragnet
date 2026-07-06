import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { generateApiKey } from "@/src/lib/apiAuth";
import { requireSession } from "@/src/lib/api-auth";

export async function GET(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, repoId: true, createdAt: true, lastUsedAt: true, revoked: true },
  });
  return NextResponse.json(keys);
}

export async function POST(req: Request) {
  try {
    await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Name is required to label this key." }, { status: 400 });
  }

  const { raw, prefix, hash } = generateApiKey();

  const data: { name: string; prefix: string; hash: string; repoId?: string } = { name, prefix, hash };
  if (body.repoId && typeof body.repoId === "string") {
    data.repoId = body.repoId;
  }

  await prisma.apiKey.create({ data });

  return NextResponse.json({
    key: raw,
    prefix,
    name,
    repoId: data.repoId || null,
    message: "Copy this key now — it won't be shown again.",
  });
}
