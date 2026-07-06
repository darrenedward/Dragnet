import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { requireSession } from "@/src/lib/api-auth";
import { clearTokenCache } from "@/src/lib/githubApp";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireSession(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connection = await prisma.oAuthConnection.findUnique({
    where: {
      userId_provider: { userId: session.user.id, provider: "github" },
    },
  });

  if (!connection) {
    return NextResponse.json({ error: "No GitHub connection found." }, { status: 404 });
  }

  clearTokenCache(connection.installationId);

  await prisma.oAuthConnection.delete({
    where: { id: connection.id },
  });

  // Also clear installationId from any repos associated with this connection
  await prisma.repository.updateMany({
    where: { installationId: connection.installationId },
    data: { installationId: null },
  });

  return NextResponse.json({ success: true });
}
