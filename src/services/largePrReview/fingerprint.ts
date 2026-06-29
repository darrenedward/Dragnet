import { createHash } from "node:crypto";
import { prisma } from "@/src/lib/prisma";

/**
 * Build a deterministic fingerprint for a finding. Stable across line shifts
 * when symbolId is available; falls back to filePath+category (no line) when not.
 *
 * Why no line in the fallback: the previous positional key (filename:line:category)
 * broke any time an unrelated fix shifted the finding's line number. Dropping line
 * from the fallback path means findings in non-symbol files (config, etc.) still
 * group correctly across runs.
 *
 * Pure function — safe to unit-test without a database.
 */
export function buildFindingFingerprint(input: {
  symbolId?: string | null;
  filePath: string;
  category: string;
}): string {
  const { symbolId, filePath, category } = input;
  const key = symbolId
    ? `sym:${symbolId}:${category}`
    : `pos:${filePath}:${category}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Resolve the tightest Symbol row containing a (filePath, line) point.
 * Uses the compound index on (repoId, filePath, lineStart, lineEnd) at
 * prisma/schema.prisma:228 — single indexed seek.
 *
 * Returns null when the point isn't inside any indexed symbol (config files,
 * scripts outside any function, etc.).
 */
export async function resolveSymbolForFinding(
  repoId: string,
  filePath: string,
  line: number | null,
): Promise<string | null> {
  if (line == null) return null;
  const symbol = await prisma.symbol.findFirst({
    where: {
      repoId,
      filePath,
      lineStart: { lte: line },
      lineEnd: { gte: line },
    },
    orderBy: { lineStart: "desc" },
    select: { id: true },
  });
  return symbol?.id ?? null;
}

/**
 * Batched version of resolveSymbolForFinding. Fetches all symbols for the
 * given file paths in one query, then in-memory matches each point to its
 * tightest containing symbol. Avoids N+1 when deduping a run with many findings.
 *
 * Returns a Map keyed by `${filePath}:${line}` → symbolId | null.
 */
export async function resolveSymbolsBatch(
  repoId: string,
  points: Array<{ filePath: string; line: number | null }>,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (points.length === 0) return result;

  const filePaths = [...new Set(points.map((p) => p.filePath))];
  const symbols = await prisma.symbol.findMany({
    where: { repoId, filePath: { in: filePaths } },
    select: { id: true, filePath: true, lineStart: true, lineEnd: true },
  });

  const byFile = new Map<string, typeof symbols>();
  for (const s of symbols) {
    const arr = byFile.get(s.filePath) ?? [];
    arr.push(s);
    byFile.set(s.filePath, arr);
  }

  for (const point of points) {
    const mapKey = `${point.filePath}:${point.line ?? "?"}`;
    if (point.line == null) {
      result.set(mapKey, null);
      continue;
    }
    const line = point.line;
    const candidates = byFile.get(point.filePath) ?? [];
    const containing = candidates.filter(
      (s) => s.lineStart <= line && s.lineEnd >= line,
    );
    if (containing.length === 0) {
      result.set(mapKey, null);
      continue;
    }
    containing.sort((a, b) => b.lineStart - a.lineStart);
    result.set(mapKey, containing[0].id);
  }

  return result;
}
