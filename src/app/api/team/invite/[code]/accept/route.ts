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
    // Pull the invitation's role so each UserRepo row reflects the
    // role the inviter picked (admin vs member). Defaults to "member"
    // for legacy invitations that don't have a role.
    const invitation = await prisma.invitation.findUnique({
      where: { id: code },
      select: { role: true, inviterId: true },
    });
    const role = invitation?.role === "admin" ? "admin" : "member";
    const inviterId = invitation?.inviterId ?? null;
    await prisma.userRepo.createMany({
      data: toCreate.map((repoId) => ({
        userId: session.user.id,
        repoId,
        role,
        invitedById: inviterId,
      })),
    });
  }

  await prisma.pendingRepoAssignment.deleteMany({
    where: { invitationId: code },
  });

  return NextResponse.json({ success: true, repoIds });
}
