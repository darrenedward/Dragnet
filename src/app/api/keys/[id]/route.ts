import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { id } = await params;

  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) {
    return NextResponse.json({ error: "API key not found." }, { status: 404 });
  }

  // Ownership check: user can only revoke their own keys.
  // Admins (session-based) can revoke any key.
  const isSession = !req.headers.get("authorization")?.startsWith("Bearer ");
  if (!isSession) {
    // API key auth — only allow deleting own keys
    if (auth.userId && key.userId && auth.userId !== key.userId) {
      return NextResponse.json({ error: "You can only revoke your own API keys." }, { status: 403 });
    }
  }

  await prisma.apiKey.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
