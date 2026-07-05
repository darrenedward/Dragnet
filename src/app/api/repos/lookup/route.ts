import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, generateApiKey } from "@/src/lib/apiAuth";
import { computeRepoId } from "@/src/lib/repoIdentity";

export async function GET(req: Request) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const url = new URL(req.url);
  const remoteUrl = url.searchParams.get("remoteUrl");
  if (!remoteUrl) {
    return NextResponse.json({ error: "remoteUrl query parameter is required" }, { status: 400 });
  }

  let repoId: string;
  try {
    repoId = computeRepoId(remoteUrl);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }

  const repo = await prisma.repository.findFirst({
    where: { repoId },
    select: { id: true, name: true },
  });

  if (!repo) {
    return NextResponse.json({ exists: false, repoId });
  }

  const key = generateApiKey();
  await prisma.apiKey.create({
    data: {
      name: `dragnet-init:${repo.name}`,
      prefix: key.prefix,
      hash: key.hash,
      repoId: repo.id,
    },
  });

  const apiBase = process.env.DRAGNET_PUBLIC_URL || url.origin;

  return NextResponse.json({
    exists: true,
    repoId: repo.id,
    repoIdNormalized: repoId,
    apiKey: key.raw,
    apiBase,
  });
}
