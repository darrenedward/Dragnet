import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";
import { mkdtempSync, rmSync } from "node:fs";
import { shellEscape } from "@/src/lib/shellEscape";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

const GIT_IMAGE = process.env.DRAGNET_GIT_IMAGE ?? "alpine/git";

function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
}

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

    await prisma.repository.updateMany({ where: { id }, data: { status: "stabilizing", indexedAt: null } });

    const indexFromPath = async () => {
      if (repo.path) {
        await IndexingService.clearIndex(id);
        const result = await IndexingService.indexFolder(id, repo.path);
        await prisma.repository.update({
          where: { id },
          data: { indexedAt: new Date().toISOString(), status: "idle" },
        });
        return result;
      }
      const orchestrator = ContainerOrchestrator.getInstance();
      const isContainerMode = !repo.localPath || repo.localPath === "/workspace";
      const volName = isContainerMode ? volumeName(id) : repo.localPath!;

      // Ensure the working tree has checked-out files. git fetch creates
      // branches but does NOT populate the working tree — without this,
      // copyVolumeToHost copies an empty directory and the indexer finds
      // nothing. Fall back gracefully if neither baseBranch nor master exist.
      const baseBranch = repo.baseBranch || "main";
      await orchestrator.runRunner({
        volumeName: volName,
        image: GIT_IMAGE,
        commands: [
          `cd /workspace && git checkout --force '${shellEscape(baseBranch)}' 2>/dev/null || git checkout --force master 2>/dev/null || echo "no checkout target — repo may be empty"`,
        ],
        networkMode: "none",
        timeoutMs: 60_000,
      }).catch((err: Error) => {
        console.warn(`[reindex] checkout failed for ${id}:`, err.message);
      });

      const tmpDir = mkdtempSync(path.join(os.tmpdir(), `dragnet-idx-${id}-`));
      try {
        await orchestrator.copyVolumeToHost(volName, tmpDir, GIT_IMAGE);
        await IndexingService.clearIndex(id);
        const result = await IndexingService.indexFolder(id, tmpDir);
        await prisma.repository.update({
          where: { id },
          data: { indexedAt: new Date().toISOString(), status: "idle" },
        });
        return result;
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
      { accepted: true, status: "stabilizing", message: "Reindex dispatched. Poll GET /api/repos/[id] for completion." },
      { status: 202 },
    );
  } catch (err: any) {
    console.error("Failed dispatching reindex:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
