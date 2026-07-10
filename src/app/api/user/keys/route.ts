import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";

/**
 * GET /api/user/keys
 *
 * Returns API keys owned by the authenticated user, optionally filtered by
 * repoId via ?repoId=<id>.  Teammates see only their own keys.
 *
 * Used by:
 *  - Repo Settings → API Keys tab (per-user, per-repo)
 *  - LLM Config → API Keys panel (global keys)
 */
export async function GET(req: Request) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const repoId = searchParams.get("repoId");

  const where: { userId: string; repoId?: string } = { userId };
  if (repoId) {
    // Verify the user is assigned to this repo before filtering by it
    const assignment = await prisma.userRepo.findUnique({
      where: { userId_repoId: { userId, repoId } },
    });
    if (!assignment) {
      return NextResponse.json({ error: "Not assigned to this repository." }, { status: 403 });
    }
    where.repoId = repoId;
  }

  const keys = await prisma.apiKey.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      repoId: true,
      userId: true,
      createdAt: true,
      lastUsedAt: true,
      revoked: true,
    },
  });

  return NextResponse.json(keys);
}
