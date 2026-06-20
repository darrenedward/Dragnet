import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres" });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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
    const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(process.cwd(), repoPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Repository local path "${repoPath}" could not be located.`);
    }

    const allFiles: string[] = [];
    this.walkDirSync(resolvedPath, allFiles);

    // Filter relevant files
    const targetExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".cpp", ".cc", ".h", ".hpp"];
    const filesToParse = allFiles.filter(f => targetExts.includes(path.extname(f).toLowerCase()));

    // Delete old index for this repo to maintain clean consistency
    await prisma.symbol.deleteMany({ where: { repoId } });
    await prisma.edge.deleteMany({ where: { repoId } });
    await prisma.file.deleteMany({ where: { repoId } });

    let symbolsCount = 0;
    const rawCallAccumulator: { fromSymbolName: string; toRaw: string; line: number; filePath: string }[] = [];
    
    // Key mapped: filePath -> SymbolId
    const symbolNameIdMap: Record<string, string> = {};

    for (const absoluteFilePath of filesToParse) {
      try {
        const relativePath = path.relative(resolvedPath, absoluteFilePath);
        const code = fs.readFileSync(absoluteFilePath, "utf-8");
        const hash = crypto.createHash("md5").update(code).digest("hex");

        // Insert index manifest file row
        await prisma.file.create({
          data: {
            repoId: repoId,
            filePath: relativePath,
            fileHash: hash,
            parsedAt: BigInt(Date.now())
          }
        });

        // Parse content
        const { symbols, rawCalls } = this.parseFileSymbols(repoId, relativePath, code);

        // Put symbols into database
        for (const meta of symbols) {
          const symId = `sym-${repoId}-${crypto.createHash("md5").update(relativePath + meta.name).digest("hex").slice(0, 10)}`;
          
          await prisma.symbol.create({
            data: {
              id: symId,
              repoId: repoId,
              filePath: relativePath,
              name: meta.name,
              kind: meta.kind,
              language: meta.language,
              lineStart: meta.lineStart,
              lineEnd: meta.lineEnd,
              signature: meta.signature || null,
              sourceHash: meta.sourceHash
            }
          });

          symbolsCount++;
          
          // Map index by file+name and also globally by name for lookup
          symbolNameIdMap[`${relativePath}|${meta.name}`] = symId;
          symbolNameIdMap[meta.name] = symId;
        }

        // Add raw class scope method namespaces
        for (const call of rawCalls) {
          rawCallAccumulator.push({
            ...call,
            filePath: relativePath
          });
        }

      } catch (err) {
        console.warn(`[Indexing Warning] Failed compiling tokens for file ${absoluteFilePath}`, err);
      }
    }

    // Now resolve Call Graph edges
    let edgesResolved = 0;
    let edgeIndex = 1;

    for (const call of rawCallAccumulator) {
      const fromSymbolId = symbolNameIdMap[`${call.filePath}|${call.fromSymbolName}`] || symbolNameIdMap[call.fromSymbolName];
      if (!fromSymbolId) continue;

      // Find toSymbolId (linked function)
      // 1. Check local file namespace matches
      let toSymbolId = symbolNameIdMap[`${call.filePath}|${call.toRaw}`];
      if (!toSymbolId) {
        // 2. Scan class namespaces (e.g. Call is 'charge' and class method is 'Billing.charge')
        const matches = Object.keys(symbolNameIdMap).filter(k => k.endsWith(`.${call.toRaw}`) || k.endsWith(`::${call.toRaw}`));
        if (matches.length > 0) {
          toSymbolId = symbolNameIdMap[matches[0]];
        }
      }
      if (!toSymbolId) {
        // 3. Global search
        toSymbolId = symbolNameIdMap[call.toRaw];
      }

      await prisma.edge.create({
        data: {
          id: `edge-${repoId}-${edgeIndex++}`,
          repoId: repoId,
          fromId: fromSymbolId,
          toId: toSymbolId || null,
          toRaw: call.toRaw,
          kind: "call",
          filePath: call.filePath,
          line: call.line
        }
      });

      edgesResolved++;
    }

    // Trigger Phase B background summary & embedding generation
    this.startBackgroundEnrichment(repoId, resolvedPath);

    // Mark repository status ready
    await prisma.repository.updateMany({ where: { id: repoId }, data: { status: 'idle' } });

    return {
      fileParsedCount: filesToParse.length,
      symbolsExtractedCount: symbolsCount,
      edgesResolvedCount: edgesResolved
    };
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

        const resolvedPath = path.isAbsolute(repoPath) ? repoPath : path.resolve(process.cwd(), repoPath);

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
