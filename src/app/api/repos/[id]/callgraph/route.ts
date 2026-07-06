import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: call graph exposes repo structure + signatures.
  // proxy.ts is cookie-PRESENCE only — must validate the session.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const symbols = await prisma.symbol.findMany({ where: { repoId: id } });
    const edges = await prisma.edge.findMany({ where: { repoId: id } });

    const nodes = symbols.map(s => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      filePath: s.filePath,
      lineStart: s.lineStart,
      signature: s.signature
    }));

    const links = edges.map(e => ({
      id: e.id,
      source: e.fromId,
      target: e.toId || null,
      targetRaw: e.toRaw,
      kind: e.kind,
      line: e.line,
      filePath: e.filePath
    }));

    return NextResponse.json({ nodes, links });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
