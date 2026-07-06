import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: edges expose repo call structure. proxy.ts is
  // cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const edges = await prisma.edge.findMany({ where: { repoId: id } });
    return NextResponse.json(edges);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
