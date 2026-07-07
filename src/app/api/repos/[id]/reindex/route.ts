import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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

    if (!repo.path && !repo.localPath) {
      return NextResponse.json(
        { error: "NO_PATH_FOUND", message: "No local path or volume configured for this repo." },
        { status: 409 },
      );
    }

    await prisma.repository.updateMany({ where: { id }, data: { status: "stabilizing" } });

    const indexFromPath = async () => {
      const srcPath = repo.path || `/mnt/${repo.localPath?.replace("dragnet-repo-", "") || id}`;
      if (repo.path) {
        return IndexingService.clearIndex(id).then(() => IndexingService.indexFolder(id, srcPath));
      }
      const orchestrator = ContainerOrchestrator.getInstance();
      const volName = repo.localPath!;
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), `dragnet-idx-${id}-`));
      try {
        await orchestrator.copyVolumeToHost(volName, tmpDir, "alpine/git".replace("alpine/git", "node:20-alpine"));
        await IndexingService.clearIndex(id);
        return await IndexingService.indexFolder(id, tmpDir);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    };

    indexFromPath()
      .then(async (stats) => {
        console.log(`[reindex] completed for ${id}:`, stats);
      })
      .catch(async (err) => {
        console.error(`[reindex] failed for ${id}:`, err);
        try {
          await prisma.repository.updateMany({ where: { id }, data: { status: "idle" } });
        } catch {}
      });

    return NextResponse.json(
      { accepted: true, status: "stabilizing", message: "Reindex dispatched. Poll GET /api/repos/[id]/stats for completion." },
      { status: 202 },
    );
  } catch (err: any) {
    console.error("Failed dispatching reindex:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
