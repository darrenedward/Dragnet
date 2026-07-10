/**
 * Index orchestrator — drives a full or incremental index run for one repo.
 *
 * Responsibilities:
 *   - Walk the repo + filter gitignored files
 *   - Compute the file diff against the existing `files` table
 *   - Call the per-file parser (currently legacyRegexParser; swaps to
 *     tsParser in Phase 7 of the tree-sitter spec)
 *   - Bulk-insert symbol rows
 *   - Resolve raw calls → edge rows (graphBuilder.ts)
 *   - Bulk-insert edge rows
 *   - Trigger background enrichment (LLM summaries + embeddings)
 *
 * Re-entrancy: one index run per repo at a time. A second request for a
 * repo already indexing is rejected with a clear error rather than racing
 * the deletes against the inserts (P2002 unique violations).
 *
 * Status flow: Repository.status = 'indexing' → 'idle' on completion.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { prisma } from "@/src/lib/prisma";
import { currentHeadCommit } from "@/src/lib/indexFreshness";
import { isSupportedFilePath } from "@/src/lib/treeSitter";
import { safeReadFileSync } from "@/src/lib/pathSafety";
import { EmbeddingService } from "../embeddingService";

import { parseFileSymbols as tsParseFileSymbols } from "./tsParser";
import {
  buildSymbolLookup,
  resolveCallsToEdges,
} from "./graphBuilder";
import {
  diffFileSets,
  readFilesForIndexing,
} from "./incrementalUpdater";
import type { FileOnDisk, ParsedFile } from "./types";

export interface IndexRunResult {
  fileParsedCount: number;
  symbolsExtractedCount: number;
  edgesResolvedCount: number;
}

// The v1 indexer only fully parses TS/JS. Other extensions are walked but
// produce no symbols until follow-on language specs land. NOTE: this list
// drives the file-walk extension filter, NOT parser dispatch — see
// `parseFile` below for per-extension dispatch.
const TARGET_EXTS_V1 = [".ts", ".tsx", ".js", ".jsx"];

const IGNORE_DIRS = [
  "node_modules", ".git", "dist", "build", "target", "venv",
  ".venv", "bin", "obj", ".next", "out",
];

const DB_CHUNK_SIZE = 100;

export class IndexingService {
  /** Repo ids with an in-flight index run. Prevents concurrent requests
   *  from racing the delete phase against each other's insert phase. */
  private static activeIndexers = new Set<string>();
  private static activeEnrichers = new Set<string>();

  /** True if an index run is currently in progress for this repo. */
  public static isIndexing(repoId: string): boolean {
    return IndexingService.activeIndexers.has(repoId);
  }

  public static async indexFolder(
    repoId: string,
    repoPath: string,
  ): Promise<IndexRunResult> {
    if (IndexingService.activeIndexers.has(repoId)) {
      throw new Error(
        "Index already in progress for this repo — wait for the current run to finish.",
      );
    }
    IndexingService.activeIndexers.add(repoId);
    try {
      return await IndexingService.runIndex(repoId, repoPath);
    } finally {
      IndexingService.activeIndexers.delete(repoId);
    }
  }

  public static async clearIndex(repoId: string): Promise<void> {
    await prisma.file.deleteMany({ where: { repoId } });
    await prisma.symbol.deleteMany({ where: { repoId } });
    await prisma.edge.deleteMany({ where: { repoId } });
  }

  private static async runIndex(
    repoId: string,
    repoPath: string,
  ): Promise<IndexRunResult> {
    const resolvedPath = path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Repository local path "${repoPath}" could not be located.`);
    }

    const allFiles: string[] = [];
    this.walkDirSync(resolvedPath, allFiles);
    const ignored = this.filterGitIgnored(resolvedPath, allFiles);
    const unignored = allFiles.filter((f) => !ignored.has(f));

    const filesOnDisk = readFilesForIndexing(resolvedPath, unignored, TARGET_EXTS_V1);

    const existingFiles = await prisma.file.findMany({ where: { repoId } });
    const diff = diffFileSets(
      filesOnDisk,
      existingFiles.map((f) => ({ filePath: f.filePath, fileHash: f.fileHash })),
    );

    // Short-circuit when nothing changed.
    if (
      diff.changed.length === 0 &&
      diff.deletedFilePaths.length === 0 &&
      existingFiles.length > 0
    ) {
      const headAtShortCircuit = await currentHeadCommit({ id: repoId, path: resolvedPath });
      await prisma.repository.updateMany({
        where: { id: repoId },
        data: {
          status: "idle",
          indexedAt: new Date().toISOString(),
          lastCommitHash: headAtShortCircuit ?? "",
        },
      });
      const totalSymbols = await prisma.symbol.count({ where: { repoId } });
      const totalEdges = await prisma.edge.count({ where: { repoId } });
      return {
        fileParsedCount: existingFiles.length,
        symbolsExtractedCount: totalSymbols,
        edgesResolvedCount: totalEdges,
      };
    }

    await this.pruneDeletedAndChangedSymbols(repoId, diff.deletedFilePaths, diff.changed);

    // Load existing symbols (excluding changed files) for cross-file edge resolution.
    const existingSymbols = await prisma.symbol.findMany({ where: { repoId } });
    const changedPathSet = new Set(diff.changed.map((f) => f.relativePath));
    const lookup = buildSymbolLookup(
      existingSymbols.map((s) => ({ id: s.id, filePath: s.filePath, name: s.name })),
      [...changedPathSet],
    );

    // Parse changed + new files.
    const fileRows: Array<{ repoId: string; filePath: string; fileHash: string; parsedAt: bigint }> = [];
    const symbolRows: Array<{
      id: string; repoId: string; filePath: string; name: string;
      kind: string; language: string; lineStart: number; lineEnd: number;
      signature: string | null; sourceHash: string;
    }> = [];
    const rawCallAccumulator: Array<{ fromSymbolName: string; toRaw: string; line: number; filePath: string }> = [];

    let symbolsCount = 0;

    for (const f of diff.changed) {
      try {
        fileRows.push({
          repoId,
          filePath: f.relativePath,
          fileHash: f.hash,
          parsedAt: BigInt(Date.now()),
        });

        const parsed = await this.parseFile(repoId, f.relativePath, f.code);

        for (const meta of parsed.symbols) {
          const symId = makeSymbolId(repoId, f.relativePath, meta);
          symbolRows.push({
            id: symId,
            repoId,
            filePath: f.relativePath,
            name: meta.name,
            kind: meta.kind,
            language: meta.language,
            lineStart: meta.lineStart,
            lineEnd: meta.lineEnd,
            signature: meta.signature || null,
            sourceHash: meta.sourceHash,
          });
          symbolsCount++;
          lookup[`${f.relativePath}|${meta.name}`] = symId;
          lookup[meta.name] = symId;
        }

        for (const call of parsed.rawCalls) {
          rawCallAccumulator.push({ ...call, filePath: f.relativePath });
        }
      } catch (err) {
        console.warn(`[Indexing Warning] Failed parsing file ${f.absolutePath}`, err);
      }
    }

    // Bulk insert files + symbols.
    for (let i = 0; i < fileRows.length; i += DB_CHUNK_SIZE) {
      await prisma.file.createMany({
        data: fileRows.slice(i, i + DB_CHUNK_SIZE),
        skipDuplicates: true,
      });
    }
    for (let i = 0; i < symbolRows.length; i += DB_CHUNK_SIZE) {
      await prisma.symbol.createMany({
        data: symbolRows.slice(i, i + DB_CHUNK_SIZE),
        skipDuplicates: true,
      });
    }

    // Resolve edges.
    const { edges } = resolveCallsToEdges(rawCallAccumulator, lookup, repoId);
    const edgeRows = edges.map((e) => ({
      id: e.id, repoId: e.repoId, fromId: e.fromId, toId: e.toId,
      toRaw: e.toRaw, kind: e.kind, filePath: e.filePath, line: e.line,
    }));
    for (let i = 0; i < edgeRows.length; i += DB_CHUNK_SIZE) {
      await prisma.edge.createMany({
        data: edgeRows.slice(i, i + DB_CHUNK_SIZE),
        skipDuplicates: true,
      });
    }

    if (diff.changed.length > 0) {
      this.startBackgroundEnrichment(repoId, resolvedPath);
    }

    const headAtCompletion = await currentHeadCommit({ id: repoId, path: resolvedPath });
    await prisma.repository.updateMany({
      where: { id: repoId },
      data: {
        status: "idle",
        indexedAt: new Date().toISOString(),
        lastCommitHash: headAtCompletion ?? "",
      },
    });

    return {
      fileParsedCount: diff.changed.length,
      symbolsExtractedCount: symbolsCount,
      edgesResolvedCount: edgeRows.length,
    };
  }

  /**
   * Dispatches a file to the right parser by extension.
   *
   * v1: TS/JS/TSX/JSX → tree-sitter parser (tsParser.ts).
   * Other extensions (Python, Go, etc.) return an empty parse with a
   * logged warning — they're walked but contribute zero symbols until
   * follow-on language specs land. Honest partial indexing, not a regex
   * fallback that would produce wrong line ranges.
   */
  private static async parseFile(
    repoId: string,
    filePath: string,
    content: string,
  ): Promise<ParsedFile> {
    if (!isSupportedFilePath(filePath)) {
      console.warn(
        `[indexing] skipping ${filePath}: no grammar yet (v1 supports .ts/.tsx/.js/.jsx)`,
      );
      return { symbols: [], rawCalls: [] };
    }
    return tsParseFileSymbols(repoId, filePath, content);
  }

  private static async pruneDeletedAndChangedSymbols(
    repoId: string,
    deletedPaths: string[],
    changedFiles: FileOnDisk[],
  ): Promise<void> {
    const changedPaths = changedFiles.map((f) => f.relativePath);
    const paths = [...deletedPaths, ...changedPaths];
    if (paths.length === 0) return;

    await prisma.$transaction([
      prisma.file.deleteMany({ where: { repoId, filePath: { in: paths } } }),
      prisma.symbol.deleteMany({ where: { repoId, filePath: { in: paths } } }),
      prisma.edge.deleteMany({ where: { repoId, filePath: { in: paths } } }),
    ]);
  }

  /**
   * Uses execFileSync (no shell) so weird paths can't inject — args are
   * passed directly to git, not interpolated into a command string.
   * Mirrors `src/lib/indexFreshness.ts:41` and `src/lib/webhook.ts:28`.
   *
   * On non-critical failures (dubious ownership, no .git, etc.) returns
   * an empty set so indexing can proceed. The IGNORE_DIRS list already
   * prevents the most dangerous patterns (node_modules, .git, .next, etc.),
   * so a failed gitignore probe is not a security risk.
   */
  private static filterGitIgnored(repoPath: string, files: string[]): Set<string> {
    if (files.length === 0) return new Set();
    try {
      const stdout = execFileSync(
        "git",
        ["-C", repoPath, "check-ignore", "--stdin"],
        {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          input: files.join("\n"),
        },
      );
      return new Set(stdout.trim().split("\n").filter(Boolean));
    } catch (e: any) {
      if (e.stdout) {
        const lines = String(e.stdout).trim().split("\n").filter(Boolean);
        if (lines.length > 0) return new Set(lines);
      }
      console.warn(
        `[indexing] filterGitIgnored failed — proceeding without gitignore check: ${e.stderr?.toString().trim() || e.message || "Unknown error"}`,
      );
      return new Set();
    }
  }

  private static walkDirSync(dir: string, fileList: string[]): void {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (IGNORE_DIRS.includes(item)) continue;
      const fullPath = path.join(dir, item);
      // lstatSync (not statSync) so symlinks are NOT followed. A malicious
      // repo containing `secrets -> /etc/` or `dump -> ~/.ssh/id_rsa` would
      // otherwise have its target read, persisted as Symbol.summary, and
      // forwarded to the configured chat LLM provider by the background
      // enricher. Skip the entry entirely — breaking symlinks inside the
      // repo are not indexed.
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        this.walkDirSync(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    }
  }

  /**
   * Phase B: runs in the background to generate natural-language summaries
   * and embeddings for symbols that don't have them yet. Fires-and-forgets
   * on a setTimeout so the index API response doesn't block on it.
   */
  public static startBackgroundEnrichment(repoId: string, repoPath: string): void {
    if (this.activeEnrichers.has(repoId)) return;
    this.activeEnrichers.add(repoId);
    setTimeout(async () => {
      try {
        const symbolsToEnrich = await prisma.symbol.findMany({
          where: {
            repoId,
            summary: null,
            summaryAt: null,
          },
          take: 100,
        });

        if (symbolsToEnrich.length === 0) {
          this.activeEnrichers.delete(repoId);
          return;
        }

        const resolvedPath = path.isAbsolute(repoPath)
          ? repoPath
          : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);

        for (const sym of symbolsToEnrich) {
          // Defense-in-depth: sym.filePath comes from the indexer (relative
          // paths) but a future schema change or compromised DB write could
          // inject an absolute path or `..` traversal. safeReadFileSync
          // resolves + opens + reads with O_NOFOLLOW in one step, closing
          // the TOCTOU window that resolveSafePath + readFileSync would
          // leave open. Returns null if path escapes repo or read fails.
          const sourceContent = safeReadFileSync(resolvedPath, sym.filePath);
          if (sourceContent === null) continue;

          const lines = sourceContent.split("\n");
          const end = Math.min(sym.lineEnd, sym.lineStart + 300, lines.length);
          const sourceCode = lines
            .slice(Math.max(0, sym.lineStart - 1), end)
            .join("\n");

          const summary = await EmbeddingService.generateSummary(
            sym.name,
            sym.filePath,
            sym.signature || sym.name,
            sourceCode,
          );
          const now = BigInt(Date.now());
          if (!summary) {
            await prisma.$executeRaw`UPDATE "symbols" SET "summaryAt" = ${now} WHERE "id" = ${sym.id}`;
            continue;
          }

          const vector = await EmbeddingService.generateEmbedding(summary);
          if (!vector || vector.length === 0) {
            await prisma.$executeRaw`UPDATE "symbols" SET "summary" = ${summary}, "summaryAt" = ${now} WHERE "id" = ${sym.id}`;
            continue;
          }

          const vectorStr = JSON.stringify(vector);
          try {
            await prisma.$executeRaw`UPDATE "symbols" SET "summary" = ${summary}, "summaryAt" = ${now}, "embedding" = ${vectorStr}::vector WHERE "id" = ${sym.id}`;
          } catch (castErr: any) {
            // Vector dimension mismatch with the pgvector column (likely
            // EMBEDDING_DIM is wrong for the active provider, or the model
            // changed). Previously this threw out of the per-symbol loop,
            // was caught by the outer try at line ~398, and enrichment was
            // abandoned WITHOUT setting summaryAt — so the same symbol was
            // retried on every future pass with the same broken cast.
            //
            // Fix: persist summaryAt as a sentinel so this symbol is not
            // retried. The operator needs to fix EMBEDDING_DIM or switch
            // the embedding provider, then re-index to backfill vectors.
            console.error(
              `[indexing] embedding cast failed for symbol ${sym.id} (dim=${vector.length}, expected column dim). ` +
              `Marking summaryAt to prevent retry loop. Fix EMBEDDING_DIM or embedding provider config and re-index.`,
              castErr.message,
            );
            await prisma.$executeRaw`UPDATE "symbols" SET "summary" = ${summary}, "summaryAt" = ${now} WHERE "id" = ${sym.id}`;
          }

          await new Promise((r) => setTimeout(r, 2000));
        }

        this.activeEnrichers.delete(repoId);
        this.startBackgroundEnrichment(repoId, repoPath);
      } catch (err) {
        console.error("Background enrichment failed:", err);
        this.activeEnrichers.delete(repoId);
      }
    }, 1000);
  }

  /**
   * Searches local symbols using semantic cosine similarity of their embeddings.
   */
  public static async semanticSearch(repoId: string, query: string, limit = 5) {
    const queryVector = await EmbeddingService.generateEmbedding(query);
    if (!queryVector || queryVector.length === 0) return [];

    const vectorStr = JSON.stringify(queryVector);
    const scored = await prisma.$queryRaw<any[]>`
      SELECT id, "repoId", "filePath", name, kind, language, "lineStart", "lineEnd", signature, "sourceHash", summary,
             1 - (embedding <=> ${vectorStr}::vector) as score
      FROM "symbols"
      WHERE "repoId" = ${repoId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${limit}
    `;
    return scored;
  }
}

/**
 * Deterministic symbol ID. Stability across re-parses is what PRD §12.3
 * (incremental update) relies on — same input → same id.
 *
 * NOTE: pre-tree-sitter scheme was hash(filePath + name). The new scheme
 * adds `kind` + `lineStart` so duplicate names in different scopes (two
 * `handleClick` methods on different classes) get distinct IDs.
 */
function makeSymbolId(
  repoId: string,
  filePath: string,
  meta: { kind: string; name: string; lineStart: number },
): string {
  const seed = `${filePath}|${meta.kind}|${meta.name}|${meta.lineStart}`;
  const hash = crypto.createHash("md5").update(seed).digest("hex").slice(0, 12);
  return `sym-${repoId}-${hash}`;
}
