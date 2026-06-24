import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateIfExternal } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateIfExternal(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
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

    await prisma.repository.updateMany({ where: { id }, data: { status: "stabilizing" } });

    IndexingService.clearIndex(id)
      .then(() => IndexingService.indexFolder(id, repo.path))
      .then(async (stats) => {
        console.log(`[reindex] completed for ${id}:`, stats);
      })
      .catch(async (err) => {
        console.error(`[reindex] failed for ${id}:`, err);
        try {
          await prisma.repository.updateMany({ where: { id }, data: { status: "idle" } });
        } catch {}
      });

    return NextResponse.json({ success: true, reindex: true });
  } catch (err: any) {
    console.error("Failed dispatching reindex:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
