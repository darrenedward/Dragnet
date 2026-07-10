import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey, enforceRepoScope } from "@/src/lib/apiAuth";
import { currentHeadCommit } from "@/src/lib/indexFreshness";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { id } = await params;
    const scopeErr = enforceRepoScope(auth, id);
    if (scopeErr) return NextResponse.json(scopeErr, { status: 403 });
    const repo = await prisma.repository.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        path: true,
        indexedAt: true,
        lastCommitHash: true,
        cloneUrl: true,
        cloneUrlHttps: true,
        deployKeyCipher: true,
        deployKeyIv: true,
        deployKeyTag: true,
        patCipher: true,
        patIv: true,
        patTag: true,
      },
    });
    if (!repo) {
      return NextResponse.json({ error: "Repository not found" }, { status: 404 });
    }

    const [fileCount, symbolCount, edgeCount] = await Promise.all([
      prisma.file.count({ where: { repoId: id } }),
      prisma.symbol.count({ where: { repoId: id } }),
      prisma.edge.count({ where: { repoId: id } }),
    ]);

    const headCommit = repo.path || repo.cloneUrl ? await currentHeadCommit(repo) : null;

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
    // `embedding` is a Prisma `Unsupported("vector")` column, so it can't be
    // filtered via the typed `where` — count it with raw SQL instead.
    const [embedRows, distinctFileRows, totalSymbols] = await Promise.all([
      prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*)::bigint AS count FROM "symbols" WHERE "repoId" = ${repoId} AND embedding IS NOT NULL`,
      prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT "filePath")::bigint AS count FROM "symbols" WHERE "repoId" = ${repoId} AND embedding IS NOT NULL`,
      prisma.symbol.count({ where: { repoId } }),
    ]);
    const symbolsWithEmbeds = Number(embedRows[0]?.count ?? 0);
    // fileCountWithEmbeddings = distinct files containing at least one
    // embedded symbol. Previously returned totalFiles (always equal to
    // fileCount), which made the UI's "X/Y files" coverage line always
    // render "Y/Y" — misleading. Now reflects actual file coverage.
    const filesWithEmbeds = Number(distinctFileRows[0]?.count ?? 0);
    return {
      fileCountWithEmbeddings: filesWithEmbeds,
      embeddingCoveragePct: totalSymbols > 0 ? Math.round((symbolsWithEmbeds / totalSymbols) * 100) : 0,
    };
  } catch {
    return { embeddingCoveragePct: 0, fileCountWithEmbeddings: 0 };
  }
}
