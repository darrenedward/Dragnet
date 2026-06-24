/**
 * Shared types for the indexing pipeline.
 *
 * The indexer parses source files into `SymbolNode`s (functions, classes,
 * methods) and `RawCall`s (unresolved call sites). Calls are later resolved
 * into `EdgeNode`s by `graphBuilder.ts` once all symbols in a repo are known.
 */

export type SymbolKind = "function" | "class" | "method" | "variable";

export type EdgeKind = "CALLS" | "IMPORTS" | "DEFINES" | "EXTENDS" | "OVERRIDES";

export interface SymbolNode {
  id: string;
  repoId: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
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
  fromId: string;
  toId?: string;
  toRaw: string;
  kind: EdgeKind;
  filePath: string;
  line: number;
}

/**
 * A call site found during parsing, before symbol-id resolution.
 * `fromSymbolName` is the enclosing function/method; `toRaw` is the
 * unresolved identifier being called.
 */
export interface RawCall {
  fromSymbolName: string;
  toRaw: string;
  line: number;
}

/**
 * Output of the per-file parser. Symbols + unresolved call sites.
 * `parseFileSymbols` in both `legacyRegexParser.ts` and `tsParser.ts`
 * must conform to this shape — that's what the orchestrator consumes.
 */
export interface ParsedFile {
  symbols: Omit<SymbolNode, "id">[];
  rawCalls: RawCall[];
}

/**
 * Used by `incrementalUpdater.ts` to describe the diff between disk
 * state and the existing `files` table rows.
 */
export interface FileOnDisk {
  absolutePath: string;
  relativePath: string;
  code: string;
  hash: string;
}

export interface FileDiff {
  unchanged: FileOnDisk[];
  changed: FileOnDisk[];
  deletedFilePaths: string[];
}

/**
 * DB row shape (subset of Prisma's Symbol type) used by the graph builder
 * for cross-file edge resolution lookups.
 */
export interface ExistingSymbolRef {
  id: string;
  filePath: string;
  name: string;
}
