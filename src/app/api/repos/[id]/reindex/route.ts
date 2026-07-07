import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    if (IndexingService.isIndexing(id)) {
      return NextResponse.json(
        { error: "ALREADY_INDEXING", message: "Indexing is already running for this repo." },
        { status: 409 },
      );
    }

    await IndexingService.clearIndex(id);
    await prisma.repository.update({
      where: { id },
      data: { indexedAt: null, status: "idle" },
    });

    console.log(`[reindex] index cleared for ${id}`);
    return NextResponse.json({
      success: true,
      message: "Index cleared. Use Index Now to rebuild.",
    });
  } catch (err: any) {
    console.error("Failed clearing index:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
