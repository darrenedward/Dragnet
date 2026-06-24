import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateIfExternal } from "@/src/lib/apiAuth";
import { currentHeadCommit } from "@/src/lib/indexFreshness";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateIfExternal(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({
      where: { id },
      select: { id: true, name: true, path: true, indexedAt: true, lastCommitHash: true },
    });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const [fileCount, symbolCount, edgeCount] = await Promise.all([
      prisma.file.count({ where: { repoId: id } }),
      prisma.symbol.count({ where: { repoId: id } }),
      prisma.edge.count({ where: { repoId: id } }),
    ]);

    const headCommit = repo.path ? currentHeadCommit(repo.path) : null;

    const { embeddingCoveragePct, fileCountWithEmbeddings } = await getEmbeddingStats(id);

    return NextResponse.json({
      indexedAt: repo.indexedAt,
      lastCommitHash: repo.lastCommitHash || null,
      headCommit,
      isStale: !!(headCommit && repo.lastCommitHash && headCommit !== repo.lastCommitHash),
      fileCount,
      symbolCount,
      edgeCount,
      fileCountWithEmbeddings,
      embeddingCoveragePct,
    });
  } catch (err: any) {
    console.error("Failed to fetch repo stats:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function getEmbeddingStats(repoId: string): Promise<{ embeddingCoveragePct: number; fileCountWithEmbeddings: number }> {
  try {
    const [totalFiles, symbolsWithEmbeds] = await Promise.all([
      prisma.file.count({ where: { repoId } }),
      prisma.symbol.count({ where: { repoId, embedding: { not: null } } }),
    ]);
    const totalSymbols = await prisma.symbol.count({ where: { repoId } });
    return {
      fileCountWithEmbeddings: totalFiles,
      embeddingCoveragePct: totalSymbols > 0 ? Math.round((symbolsWithEmbeds / totalSymbols) * 100) : 0,
    };
  } catch {
    return { embeddingCoveragePct: 0, fileCountWithEmbeddings: 0 };
  }
}
