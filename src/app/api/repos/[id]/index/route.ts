import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { IndexingService } from "@/src/services/indexingService";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route-level auth: proxy.ts only checks cookie PRESENCE. Without this,
  // any client with a fake cookie header could trigger expensive indexing
  // (CPU, disk I/O, embedding LLM calls) for DoS / cost amplification.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository record not found" }, { status: 404 });
    }

    // Refuse if a run is already in flight (lock held by IndexingService).
    // Returns 409 so the client can show "already running" instead of stacking
    // up duplicate requests.
    if (IndexingService.isIndexing(id)) {
      return NextResponse.json(
        { error: "ALREADY_INDEXING", message: "Indexing is already running for this repo." },
        { status: 409 },
      );
    }

    await prisma.repository.updateMany({ where: { id }, data: { status: 'stabilizing' } });

    // Detach the work — indexing 500+ files against Supabase pooler takes 10+
    // minutes (sequential per-file upserts). The HTTP layer would time out
    // long before completion. The frontend's 15s poller watches `indexedAt`
    // to detect completion and clears the in-progress banner.
    IndexingService.indexFolder(id, repo.path)
      .then(async (stats) => {
        console.log(`[indexing] completed for ${id}:`, stats);
      })
      .catch(async (err) => {
        console.error(`[indexing] failed for ${id}:`, err);
        try {
          await prisma.repository.updateMany({ where: { id }, data: { status: 'idle' } });
        } catch {}
      });

    return NextResponse.json({ success: true, started: true });
  } catch (err: any) {
    console.error("Failed dispatching index job:", err);
    try {
      await prisma.repository.updateMany({ where: { id: (await params).id }, data: { status: 'idle' } });
    } catch {}
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
