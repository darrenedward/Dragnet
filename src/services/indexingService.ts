/**
 * Back-compat shim. The monolithic 736-line indexer was split into
 * `src/services/indexing/` per the CLAUDE.md 500-line rule. This file
 * remains as a one-line re-export so existing callers don't need to
 * change their import path.
 *
 * New code should import from `@/src/services/indexing` directly.
 *
 * See: .agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/
 */

export { IndexingService } from "./indexing";
export type { IndexRunResult } from "./indexing";
