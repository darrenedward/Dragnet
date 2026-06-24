/**
 * TEMPORARY — line-by-line regex symbol/call extractor.
 *
 * This is the original `parseFileSymbols` from indexingService.ts. It's
 * preserved here unchanged so the Phase 6 parity tests can compare its
 * output against the tree-sitter parser (`tsParser.ts`). Once parity is
 * proven, this file is deleted in Phase 7.
 *
 * DO NOT extend. DO NOT call from new code. The orchestrator stops using
 * it after Phase 7. See:
 *   .agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/tasks.md
 *
 * Known issues (reason it's being replaced):
 *   - Brace-counting `findBlockEnd` miscounts on template literals, JSX,
 *     comments with `{` → wrong lineEnd on symbols.
 *   - `matchAll(name\()` matches keywords and control flow (`if (`, `for (`,
 *     `switch (` despite blocklists) → junk call edges.
 *   - Symbol identity non-repeatable across re-parses → breaks incremental.
 */

import type { ParsedFile } from "./types";

export class LegacyRegexParser {
  /**
   * Scans a file to extract classes, functions, variable nodes and call sites
   * using line-by-line regex pattern matching.
   *
   * Used only by parity tests. Production code uses `tsParser.ts`.
   */
  public static parseFileSymbols(
    repoId: string,
    filePath: string,
    content: string,
  ): ParsedFile {
    const filename = filePath.split("/").pop() || filePath;
    const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();

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
    const symbols: ParsedFile["symbols"] = [];
    const rawCalls: ParsedFile["rawCalls"] = [];

    const getHash = (text: string) => {
      const crypto = require("node:crypto");
      return crypto.createHash("md5").update(text).digest("hex");
    };

    let activeClassName = "";

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].trim();
      const lineNum = i + 1;

      // 1. PYTHON
      if (language === "python") {
        const classMatch = lineText.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
          activeClassName = classMatch[1];
          symbols.push({
            repoId, filePath, name: classMatch[1], kind: "class",
            language, lineStart: lineNum, lineEnd: lineNum + 5,
            signature: classMatch[0], sourceHash: getHash(lineText),
          });
          continue;
        }
        const fnMatch = lineText.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (fnMatch) {
          const fnName = fnMatch[1];
          symbols.push({
            repoId, filePath, name: fnName,
            kind: activeClassName ? "method" : "function",
            language, lineStart: lineNum,
            lineEnd: this.findBlockEnd(lines, i, language),
            signature: fnMatch[0], sourceHash: getHash(lines.slice(i, i + 8).join("\n")),
          });
          this.extractPythonCallSites(lines, i + 1, fnName, rawCalls);
        }
      }
      // 2. JS/TS
      else if (language === "javascript/typescript") {
        const classMatch = lineText.match(/(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
          activeClassName = classMatch[1];
          symbols.push({
            repoId, filePath, name: classMatch[1], kind: "class",
            language, lineStart: lineNum, lineEnd: this.findBlockEnd(lines, i, language),
            signature: classMatch[0], sourceHash: getHash(lineText),
          });
          continue;
        }
        const fnMatch = lineText.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/) ||
                        lineText.match(/(?:export\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/);
        if (fnMatch) {
          const fnName = fnMatch[1];
          symbols.push({
            repoId, filePath, name: fnName,
            kind: activeClassName ? "method" : "function",
            language, lineStart: lineNum,
            lineEnd: this.findBlockEnd(lines, i, language),
            signature: fnMatch[0], sourceHash: getHash(lines.slice(i, i + 12).join("\n")),
          });
          this.extractJsCallSites(lines, i + 1, fnName, rawCalls);
        }
      }
      // 3. RUST, 4. GO, 5. GENERIC — omitted from this temporary copy.
      // The tree-sitter replacement only needs to be parity-checked against
      // TS/JS extraction; other languages are out of scope for v1.
    }

    return { symbols, rawCalls };
  }

  private static findBlockEnd(lines: string[], startLineIdx: number, language: string): number {
    const limit = Math.min(lines.length, startLineIdx + 500);
    if (language === "python") {
      const startIndent = Math.max(0, lines[startLineIdx].search(/\S/));
      for (let i = startLineIdx + 1; i < limit; i++) {
        if (!lines[i].trim()) continue;
        if (lines[i].search(/\S/) <= startIndent) return i;
      }
      return limit;
    }
    let depth = 0;
    let started = false;
    for (let i = startLineIdx; i < limit; i++) {
      for (const char of lines[i]) {
        if (char === "{") { depth++; started = true; }
        else if (char === "}") { depth--; }
      }
      if (started && depth === 0) return i + 1;
    }
    return Math.min(lines.length, startLineIdx + 15);
  }

  private static extractPythonCallSites(
    lines: string[], startIdx: number, fromSymbolName: string,
    outCalls: ParsedFile["rawCalls"],
  ) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 30); current++) {
      const line = lines[current];
      if (line && line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) break;
      const matches = line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["print", "len", "range", "str", "int", "list", "dict", "def", "class", "if", "for", "while"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }

  private static extractJsCallSites(
    lines: string[], startIdx: number, fromSymbolName: string,
    outCalls: ParsedFile["rawCalls"],
  ) {
    for (let current = startIdx; current < Math.min(lines.length, startIdx + 40); current++) {
      const line = lines[current];
      const matches = line.matchAll(/(?:\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
      for (const m of matches) {
        const calledName = m[1];
        if (calledName && !["console", "log", "error", "warn", "map", "filter", "reduce", "require", "import", "fetch", "if", "for", "while", "catch"].includes(calledName)) {
          outCalls.push({ fromSymbolName, toRaw: calledName, line: current + 1 });
        }
      }
    }
  }
}
