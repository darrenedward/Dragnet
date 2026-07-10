import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: proxy.ts is cookie-PRESENCE only. Symbols expose
  // source signatures + summaries — gate behind real session validation.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const symbols = await prisma.symbol.findMany({ where: { repoId: id } });
    const safe = symbols.map((s) => ({
      ...s,
      summaryAt: s.summaryAt != null ? s.summaryAt.toString() : null,
    }));
    return NextResponse.json(safe);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
