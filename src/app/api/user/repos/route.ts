import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";

export async function GET(req: Request) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userRepos = await prisma.userRepo.findMany({
    where: { userId: session.user.id },
    include: {
      repository: {
        select: { id: true, name: true, status: true, indexedAt: true },
      },
    },
    orderBy: { invitedAt: "desc" },
  });

  return NextResponse.json(
    userRepos.map((ur) => ({
      userId: ur.userId,
      repoId: ur.repoId,
      role: ur.role,
      invitedAt: ur.invitedAt,
      repository: ur.repository,
    })),
  );
}
