/**
 * Barrel re-export for the indexing pipeline. Callers should import from
 * `@/src/services/indexing` (or the back-compat shim at
 * `@/src/services/indexingService`).
 *
 * Internal layout:
 *   types.ts              — shared interfaces
 *   indexOrchestrator.ts  — IndexingService class (orchestrates a run)
 *   graphBuilder.ts       — resolves raw calls → edge rows
 *   incrementalUpdater.ts — file diff against existing rows
 *   legacyRegexParser.ts  — TEMPORARY (deleted in Phase 7 of tree-sitter spec)
 *   tsParser.ts           — tree-sitter parser (lands in Phase 5)
 */

export { IndexingService } from "./indexOrchestrator";
export type { IndexRunResult } from "./indexOrchestrator";
export type {
  SymbolNode,
  EdgeNode,
  RawCall,
  ParsedFile,
  FileOnDisk,
  FileDiff,
  SymbolKind,
  EdgeKind,
} from "./types";
