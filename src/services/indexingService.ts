import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { prisma } from "../lib/prisma";
import { currentHeadCommit } from "../lib/indexFreshness";

import { EmbeddingService } from "./embeddingService";

export interface SymbolNode {
  id: string;
  repoId: string;
  filePath: string;
  name: string;
  kind: "function" | "class" | "method" | "variable";
  language: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  sourceHash: string;
  summary?: string;
  summaryAt?: number;
}

export interface EdgeNode {
  id: string;
  repoId: string;
  fromId: string; // symbol id containing the call
  toId?: string;  // linked symbol id being called (resolved)
  toRaw: string;  // name of function/symbol called
  kind: "call" | "inheritance" | "composition";
  filePath: string;
  line: number;
}

/**
 * Generic High-Fidelity Multi-Language Code AST Parser and Call-Graph Generator.
 * Employs custom pattern-matching lexer rules to extract deep semantic nodes 
 * and structural call relationships without requiring platform-native binary bindings.
 */
export class IndexingService {

  private static ignoreDirs = [
    "node_modules", ".git", "dist", "build", "target", "venv",
    ".venv", "bin", "obj", ".next", "out"
  ];

  /** Repo ids with an in-flight index run. Prevents concurrent requests
   *  from racing the delete phase against each other's insert phase. */
  private static activeIndexers = new Set<string>();

  /** True if an index run is currently in progress for this repo. */
  public static isIndexing(repoId: string): boolean {
    return IndexingService.activeIndexers.has(repoId);
  }

  /**
   * Scans a file to extract classes, functions, variable nodes and call sites.
   */
  public static parseFileSymbols(repoId: string, filePath: string, content: string): { symbols: Omit<SymbolNode, "id">[]; rawCalls: { fromSymbolName: string; toRaw: string; line: number }[] } {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    
    let language = "other";
    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      language = "javascript/typescript";
    } else if (ext === ".py") {
      language = "python";
    } else if (ext === ".rs") {
      language = "rust";
    } else if (ext === ".go") {
      language = "go";
    } else if (ext === ".java") {
      language = "java";
    } else if ([".cpp", ".cc", ".h", ".hpp"].includes(ext)) {
      language = "cpp";
    }

    const lines = content.split("\n");
    const symbols: Omit<SymbolNode, "id">[] = [];
    const rawCalls: { fromSymbolName: string; toRaw: string; line: number }[] = [];

    // Helper to calculate hash of source content chunk
    const getHash = (text: string) => {
      return crypto.createHash("md5").update(text).digest("hex");
    };

    // Tracker for class context
    let activeClassName = "";

    // Iterate line by line to discover classes and functions
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].trim();
      const lineNum = i + 1;

      // 1. PYTHON
      if (language === "python") {
        // Python Class
        const classMatch = lineText.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
          activeClassName = classMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName,
            kind: "class",
            language,
            lineStart: lineNum,
            lineEnd: lineNum + 2, // approximation
            signature: classMatch[0],
            sourceHash: getHash(lineText)
          });
          continue;
        }

        // Python Function/Method
        const defMatch = lineText.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
        if (defMatch) {
          const fnName = defMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName ? `${activeClassName}.${fnName}` : fnName,
            kind: activeClassName ? "method" : "function",
            language,
            lineStart: lineNum,
            lineEnd: Math.min(lines.length, lineNum + 10), // tentative end line
            signature: defMatch[0],
            sourceHash: getHash(lines.slice(i, i + 8).join("\n"))
          });

          // Look for calls inside Python function bodies
          this.extractPythonCallSites(lines, i + 1, activeClassName ? `${activeClassName}.${fnName}` : fnName, rawCalls);
        }
      }

      // 2. JAVASCRIPT / TYPESCRIPT
      else if (language === "javascript/typescript") {
        // Class
        const classMatch = lineText.match(/(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
          activeClassName = classMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName,
            kind: "class",
            language,
            lineStart: lineNum,
            lineEnd: lineNum + 5,
            signature: classMatch[0],
            sourceHash: getHash(lineText)
          });
          continue;
        }

        // Standard Functions or Methods inside classes
        const fnMatch = lineText.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/) ||
                        lineText.match(/(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/) ||
                        lineText.match(/public\s+(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/) ||
                        lineText.match(/private\s+(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        
        if (fnMatch) {
          const fnName = fnMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName ? `${activeClassName}.${fnName}` : fnName,
            kind: activeClassName ? "method" : "function",
            language,
            lineStart: lineNum,
            lineEnd: Math.min(lines.length, lineNum + 12),
            signature: fnMatch[0],
            sourceHash: getHash(lines.slice(i, i + 10).join("\n"))
          });

          this.extractJsCallSites(lines, i + 1, activeClassName ? `${activeClassName}.${fnName}` : fnName, rawCalls);
        }
      }

      // 3. RUST
      else if (language === "rust") {
        // Impl block (tracks context)
        const implMatch = lineText.match(/^impl(?:\s+<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (implMatch) {
          activeClassName = implMatch[1];
          continue;
        }

        // Rust Struct/Enum block
        const structMatch = lineText.match(/^(?:pub\s+)?(?:struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (structMatch) {
          symbols.push({
            repoId,
            filePath,
            name: structMatch[1],
            kind: "class",
            language,
            lineStart: lineNum,
            lineEnd: lineNum + 4,
            signature: structMatch[0],
            sourceHash: getHash(lineText)
          });
          continue;
        }

        // Rust Function (fn)
        const fnMatch = lineText.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (fnMatch) {
          const fnName = fnMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName ? `${activeClassName}::${fnName}` : fnName,
            kind: activeClassName ? "method" : "function",
            language,
            lineStart: lineNum,
            lineEnd: Math.min(lines.length, lineNum + 15),
            signature: fnMatch[0],
            sourceHash: getHash(lines.slice(i, i + 12).join("\n"))
          });

          this.extractRustCallSites(lines, i + 1, activeClassName ? `${activeClassName}::${fnName}` : fnName, rawCalls);
        }
      }

      // 4. GO
      else if (language === "go") {
        // Go struct
        const structMatch = lineText.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct/);
        if (structMatch) {
          activeClassName = structMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName,
            kind: "class",
            language,
            lineStart: lineNum,
            lineEnd: lineNum + 5,
            signature: structMatch[0],
            sourceHash: getHash(lineText)
          });
          continue;
        }

        // Go func
        const funcMatch = lineText.match(/^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/) || 
                          lineText.match(/^func\s*\(\s*[a-zA-Z0-9_* ]+\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (funcMatch) {
          const fnName = funcMatch[1];
          symbols.push({
            repoId,
            filePath,
            name: activeClassName && lineText.includes("(") && lineText.indexOf("func") === 0 && lineText.indexOf(")") < lineText.indexOf(fnName)
              ? `${activeClassName}.${fnName}`
              : fnName,
            kind: activeClassName && lineText.includes("(") && lineText.indexOf("func") === 0 && lineText.indexOf(")") < lineText.indexOf(fnName)
              ? "method"
              : "function",
            language,
            lineStart: lineNum,
            lineEnd: Math.min(lines.length, lineNum + 15),
            signature: funcMatch[0],
            sourceHash: getHash(lines.slice(i, i + 10).join("\n"))
          });

          this.extractGenericCallSites(lines, i + 1, fnName, rawCalls);
        }
      }

      // 5. OTHER GENERIC
      else {
        // Fallback functions
        const simpleFn = lineText.match(/(?:public|private|static)?\s*(?:void|int|double|String|bool|auto)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/);
        if (simpleFn) {
          const name = simpleFn[1];
          symbols.push({
            repoId,
            filePath,
            name,
            kind: "function",
            language,
            lineStart: lineNum,
            lineEnd: Math.min(lines.length, lineNum + 15),
            signature: simpleFn[0],
            sourceHash: getHash(lines.slice(i, i + 10).join("\n"))
          });
          this.extractGenericCallSites(lines, i + 1, name, rawCalls);
        }
      }
    }

    return { symbols, rawCalls };
  }

  // Support call site analysis in lines
  private static extractPythonCallSites(lines: string[], startIdx: number, fromSymbolName: string, outCalls: { fromSymbolName: string; toRaw: string; line: number }[]) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 30); current++) {
      const line = lines[current];
      // If indentation drops back to start, we are likely out of the scope
      if (line && line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
        break;
      }
      const matches = line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["print", "len", "range", "str", "int", "list", "dict", "def", "class", "if", "for", "while"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }

  private static extractJsCallSites(lines: string[], startIdx: number, fromSymbolName: string, outCalls: { fromSymbolName: string; toRaw: string; line: number }[]) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 40); current++) {
      const line = lines[current];
      // Simple brace matching boundaries might apply, let's look for call patterns
      const matches = line.matchAll(/(?:\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["console", "log", "error", "warn", "map", "filter", "reduce", "require", "import", "fetch", "if", "for", "while", "catch"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }

  private static extractRustCallSites(lines: string[], startIdx: number, fromSymbolName: string, outCalls: { fromSymbolName: string; toRaw: string; line: number }[]) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 40); current++) {
      const line = lines[current];
      const matches = line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:::<[^>]+>)?\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["println", "format", "unwrap", "expect", "vec", "Some", "None", "Ok", "Err", "match", "if", "assert", "panic", "error", "warn", "info", "debug"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }

  private static extractGenericCallSites(lines: string[], startIdx: number, fromSymbolName: string, outCalls: { fromSymbolName: string; toRaw: string; line: number }[]) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 30); current++) {
      const line = lines[current];
      const matches = line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["if", "for", "while", "switch", "catch", "printf", "sizeof"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }

  /**
   * Scans a repository completely, updating database tables for symbols, files, and edges.
   */
  public static async indexFolder(repoId: string, repoPath: string): Promise<{ fileParsedCount: number; symbolsExtractedCount: number; edgesResolvedCount: number }> {
    // Per-repo re-entrancy lock. The previous request might still be in its
    // insert loop after the client navigated away; letting a second request
    // start would race the deletes against the inserts and produce P2002
    // unique-violations on File/Symbol. Reject concurrent runs explicitly.
    if (IndexingService.activeIndexers.has(repoId)) {
      throw new Error('Index already in progress for this repo — wait for the current run to finish.');
    }
    IndexingService.activeIndexers.add(repoId);

    try {
      return await IndexingService.runIndex(repoId, repoPath);
    } finally {
      IndexingService.activeIndexers.delete(repoId);
    }
  }

  private static async runIndex(repoId: string, repoPath: string): Promise<{ fileParsedCount: number; symbolsExtractedCount: number; edgesResolvedCount: number }> {
    const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Repository local path "${repoPath}" could not be located.`);
    }

    const allFiles: string[] = [];
    this.walkDirSync(resolvedPath, allFiles);

    const ignored = this.filterGitIgnored(resolvedPath, allFiles);
    const unignored = allFiles.filter(f => !ignored.has(f));

    const targetExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".cpp", ".cc", ".h", ".hpp"];
    const filesOnDisk = unignored
      .filter(f => targetExts.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        absolutePath: f,
        relativePath: path.relative(resolvedPath, f),
        code: fs.readFileSync(f, "utf-8"),
      }))
      .map(f => ({ ...f, hash: crypto.createHash("md5").update(f.code).digest("hex") }));

    // Load existing files from DB to detect changes
    const existingFiles = await prisma.file.findMany({ where: { repoId } });
    const existingByPath = new Map(existingFiles.map(f => [f.filePath, f]));
    const diskPaths = new Set(filesOnDisk.map(f => f.relativePath));

    // Diff: unchanged (same hash), changed (different or new), deleted (in DB but not on disk)
    const unchanged: typeof filesOnDisk = [];
    const changed: typeof filesOnDisk = [];
    for (const f of filesOnDisk) {
      const existing = existingByPath.get(f.relativePath);
      if (existing && existing.fileHash === f.hash) {
        unchanged.push(f);
      } else {
        changed.push(f);
      }
    }
    const deletedFilePaths = [...existingByPath.keys()].filter(p => !diskPaths.has(p));

    // If nothing changed at all, short-circuit
    if (changed.length === 0 && deletedFilePaths.length === 0 && existingByPath.size > 0) {
      const headAtShortCircuit = currentHeadCommit(resolvedPath);
      await prisma.repository.updateMany({
        where: { id: repoId },
        data: { status: 'idle', indexedAt: new Date().toISOString(), lastCommitHash: headAtShortCircuit ?? '' },
      });
      const totalSymbols = await prisma.symbol.count({ where: { repoId } });
      const totalEdges = await prisma.edge.count({ where: { repoId } });
      return { fileParsedCount: existingByPath.size, symbolsExtractedCount: totalSymbols, edgesResolvedCount: totalEdges };
    }

    // 1. Handle deleted files: remove from files, symbols, and edges
    if (deletedFilePaths.length > 0) {
      await prisma.file.deleteMany({ where: { repoId, filePath: { in: deletedFilePaths } } });
      await prisma.symbol.deleteMany({ where: { repoId, filePath: { in: deletedFilePaths } } });
      await prisma.edge.deleteMany({ where: { repoId, filePath: { in: deletedFilePaths } } });
    }

    // 2. For changed files: remove old symbols+edges (files updated below)
    const changedPaths = changed.map(f => f.relativePath);
    if (changedPaths.length > 0) {
      await prisma.file.deleteMany({ where: { repoId, filePath: { in: changedPaths } } });
      await prisma.symbol.deleteMany({ where: { repoId, filePath: { in: changedPaths } } });
      await prisma.edge.deleteMany({ where: { repoId, filePath: { in: changedPaths } } });
    }

    // 3. Load existing (unchanged) symbols into lookup for cross-file edge resolution
    const symbolNameIdMap: Record<string, string> = {};
    const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(symbolNameIdMap, k);
    const lookup = (k: string): string | undefined => (hasOwn(k) ? symbolNameIdMap[k] : undefined);

    const existingSymbols = await prisma.symbol.findMany({ where: { repoId } });
    for (const sym of existingSymbols) {
      if (!changedPaths.includes(sym.filePath)) {
        symbolNameIdMap[`${sym.filePath}|${sym.name}`] = sym.id;
        symbolNameIdMap[sym.name] = sym.id;
      }
    }

    // 4. Parse changed + new files
    let symbolsCount = 0;
    let edgeIndex = 1;
    const rawCallAccumulator: { fromSymbolName: string; toRaw: string; line: number; filePath: string }[] = [];
    const fileRows: { repoId: string; filePath: string; fileHash: string; parsedAt: bigint }[] = [];
    const symbolRows: { id: string; repoId: string; filePath: string; name: string; kind: string; language: string; lineStart: number; lineEnd: number; signature: string | null; sourceHash: string }[] = [];

    for (const f of changed) {
      try {
        fileRows.push({
          repoId,
          filePath: f.relativePath,
          fileHash: f.hash,
          parsedAt: BigInt(Date.now()),
        });

        const { symbols, rawCalls } = this.parseFileSymbols(repoId, f.relativePath, f.code);

        for (const meta of symbols) {
          const symId = `sym-${repoId}-${crypto.createHash("md5").update(f.relativePath + meta.name).digest("hex").slice(0, 10)}`;

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
          symbolNameIdMap[`${f.relativePath}|${meta.name}`] = symId;
          symbolNameIdMap[meta.name] = symId;
        }

        for (const call of rawCalls) {
          rawCallAccumulator.push({ ...call, filePath: f.relativePath });
        }
      } catch (err) {
        console.warn(`[Indexing Warning] Failed compiling tokens for file ${f.absolutePath}`, err);
      }
    }

    // 5. Bulk insert file + symbol rows
    const CHUNK = 100;
    for (let i = 0; i < fileRows.length; i += CHUNK) {
      await prisma.file.createMany({ data: fileRows.slice(i, i + CHUNK), skipDuplicates: true });
    }
    for (let i = 0; i < symbolRows.length; i += CHUNK) {
      await prisma.symbol.createMany({ data: symbolRows.slice(i, i + CHUNK), skipDuplicates: true });
    }

    // 6. Resolve edges for changed files only (against combined symbol map)
    const edgeRows: { id: string; repoId: string; fromId: string; toId: string | null; toRaw: string; kind: string; filePath: string; line: number }[] = [];

    for (const call of rawCallAccumulator) {
      const fromSymbolId = lookup(`${call.filePath}|${call.fromSymbolName}`) || lookup(call.fromSymbolName);
      if (!fromSymbolId) continue;

      let toSymbolId = lookup(`${call.filePath}|${call.toRaw}`);
      if (!toSymbolId) {
        const matches = Object.keys(symbolNameIdMap).filter(k => Object.prototype.hasOwnProperty.call(symbolNameIdMap, k) && (k.endsWith(`.${call.toRaw}`) || k.endsWith(`::${call.toRaw}`)));
        if (matches.length > 0) {
          toSymbolId = symbolNameIdMap[matches[0]];
        }
      }
      if (!toSymbolId) {
        toSymbolId = lookup(call.toRaw);
      }

      edgeRows.push({
        id: `edge-${repoId}-${edgeIndex++}`,
        repoId,
        fromId: fromSymbolId,
        toId: toSymbolId || null,
        toRaw: call.toRaw,
        kind: "call",
        filePath: call.filePath,
        line: call.line,
      });
    }

    for (let i = 0; i < edgeRows.length; i += CHUNK) {
      await prisma.edge.createMany({ data: edgeRows.slice(i, i + CHUNK), skipDuplicates: true });
    }
    const edgesResolved = edgeRows.length;

    // 7. Background enrichment for new symbols
    if (changed.length > 0) {
      this.startBackgroundEnrichment(repoId, resolvedPath);
    }

    const headAtCompletion = currentHeadCommit(resolvedPath);
    await prisma.repository.updateMany({
      where: { id: repoId },
      data: { status: 'idle', indexedAt: new Date().toISOString(), lastCommitHash: headAtCompletion ?? '' },
    });

    return {
      fileParsedCount: changed.length,
      symbolsExtractedCount: symbolsCount,
      edgesResolvedCount: edgesResolved,
    };
  }

  public static async clearIndex(repoId: string): Promise<void> {
    await prisma.file.deleteMany({ where: { repoId } });
    await prisma.symbol.deleteMany({ where: { repoId } });
    await prisma.edge.deleteMany({ where: { repoId } });
  }

  private static filterGitIgnored(repoPath: string, files: string[]): Set<string> {
    if (files.length === 0) return new Set();

    try {
      const result = execSync("git check-ignore --stdin", {
        cwd: repoPath,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        input: files.join("\n"),
      });
      return new Set(result.trim().split("\n").filter(Boolean));
    } catch (e: any) {
      if (e.stdout) {
        const lines = String(e.stdout).trim().split("\n").filter(Boolean);
        if (lines.length > 0) return new Set(lines);
      }
      const msg = e.stderr?.toString().trim() || e.message || "Unknown error";
      throw new Error(`Cannot verify gitignore rules — aborting index to avoid exposing ignored files. ${msg}`);
    }
  }

  private static walkDirSync(dir: string, fileList: string[]) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (this.ignoreDirs.includes(item)) continue;
      
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        this.walkDirSync(fullPath, fileList);
      } else {
        fileList.push(fullPath);
      }
    }
  }

  /**
   * Phase B: Runs in the background to generate natural language summaries 
   * and embeddings for symbols that don't have them yet.
   */
  public static async startBackgroundEnrichment(repoId: string, repoPath: string) {
    // We run asynchronously to prevent blocking the UI
    setTimeout(async () => {
      try {
        // Get all un-enriched symbols for this repo
        const symbolsToEnrich = await prisma.symbol.findMany({
          where: {
            repoId,
            summary: null,
          },
          take: 100, // Batch limit to avoid rate limits
        });

        if (symbolsToEnrich.length === 0) {
          console.log(`[Indexing] repo ${repoId} is fully enriched.`);
          return;
        }

        console.log(`[Indexing] Found ${symbolsToEnrich.length} symbols to enrich for Phase B...`);

        const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(/* turbopackIgnore: true */ process.cwd(), repoPath);

        for (const sym of symbolsToEnrich) {
          const absolutePath = path.join(resolvedPath, sym.filePath);
          if (!fs.existsSync(absolutePath)) continue;

          // Read the file and slice the function text roughly.
          const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
          // To prevent huge token sends for whole classes, we limit to max 300 lines
          const end = Math.min(sym.lineEnd, sym.lineStart + 300, lines.length);
          const sourceCode = lines.slice(Math.max(0, sym.lineStart - 1), end).join("\n");

          const summary = await EmbeddingService.generateSummary(sym.name, sym.filePath, sym.signature || sym.name, sourceCode);
          if (summary) {
            const vector = await EmbeddingService.generateEmbedding(summary);
            await prisma.symbol.update({
              where: { id: sym.id },
              data: {
                summary,
                summaryAt: BigInt(Date.now()),
                embedding: JSON.stringify(vector),
              }
            });
            console.log(`[Indexing] Enriched: ${sym.name}`);
          }

          // Gentle delay to respect API bounds
          await new Promise(r => setTimeout(r, 2000));
        }

        // Loop recursively until done
        this.startBackgroundEnrichment(repoId, repoPath);

      } catch (err) {
        console.error("Background enrichment failed:", err);
      }
    }, 1000);
  }

  /**
   * Searches local symbols using semantic cosine similarity of their embeddings.
   */
  public static async semanticSearch(repoId: string, query: string, limit = 5) {
    const queryVector = await EmbeddingService.generateEmbedding(query);
    if (!queryVector || queryVector.length === 0) return [];

    const allEnriched = await prisma.symbol.findMany({
      where: { repoId, embedding: { not: null } }
    });

    const scored = allEnriched.map(sym => {
      const vec = JSON.parse(sym.embedding as string) as number[];
      const score = EmbeddingService.cosineSimilarity(queryVector, vec);
      return { sym, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => ({
      ...s.sym,
      score: s.score
    }));
  }
}
