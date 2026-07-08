import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { code } = await params;

  const assignments = await prisma.pendingRepoAssignment.findMany({
    where: { invitationId: code },
  });
  if (assignments.length === 0) {
    return NextResponse.json({ success: true, repoIds: [] });
  }

  const repoIds = [...new Set(assignments.map((a) => a.repoId))];
  const existing = await prisma.userRepo.findMany({
    where: { userId: session.user.id, repoId: { in: repoIds } },
    select: { repoId: true },
  });
  const existingRepoIds = new Set(existing.map((e) => e.repoId));
  const toCreate = repoIds.filter((r) => !existingRepoIds.has(r));

  if (toCreate.length > 0) {
    await prisma.userRepo.createMany({
      data: toCreate.map((repoId) => ({
        userId: session.user.id,
        repoId,
        invitedById: null,
      })),
    });
  }

  await prisma.pendingRepoAssignment.deleteMany({
    where: { invitationId: code },
  });

  return NextResponse.json({ success: true, repoIds });
}
