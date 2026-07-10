import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";
import { verifyInviterIsOwnerOrAdmin } from "@/src/lib/apiAuth";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const {
    email,
    role = "admin",
    repoIds,
  }: { email?: string; role?: string; repoIds?: string[] } = body;

  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }
  if (!Array.isArray(repoIds) || repoIds.length === 0) {
    return NextResponse.json({ error: "At least one repo must be selected." }, { status: 400 });
  }

  const validRepos = await prisma.repository.findMany({
    where: { id: { in: repoIds } },
    select: { id: true },
  });
  if (validRepos.length !== repoIds.length) {
    return NextResponse.json({ error: "One or more selected repos not found." }, { status: 400 });
  }

  // Unified access model from #69: the inviter must be the owner or an
  // admin of EVERY selected repo. Per-repo gate (not org membership)
  // because the schema is now per-repo, not per-org.
  for (const repoId of repoIds) {
    const check = await verifyInviterIsOwnerOrAdmin(session.user.id, repoId);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error ?? "Not authorized to invite to this repository." },
        { status: 403 },
      );
    }
  }

  // Create invitation directly in the database (Better Auth will recognize it)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await prisma.invitation.create({
    data: {
      organizationId: null,
      email: email.trim().toLowerCase(),
      role,
      expiresAt,
      inviterId: session.user.id,
    },
  });

  await prisma.pendingRepoAssignment.createMany({
    data: repoIds.map((repoId) => ({ invitationId: invitation.id, repoId })),
  });

  return NextResponse.json({ success: true, invitationId: invitation.id, repoIds });
}
