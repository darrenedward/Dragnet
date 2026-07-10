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

  const connection = await prisma.oAuthConnection.findUnique({
    where: {
      userId_provider: { userId: session.user.id, provider: "github" },
    },
  });

  if (!connection) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    installationId: connection.installationId,
    createdAt: connection.createdAt.toISOString(),
  });
}
