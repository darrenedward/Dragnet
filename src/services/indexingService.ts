/**
 * Back-compat shim. The monolithic 736-line indexer was split into
 * `src/services/indexing/` to keep the implementation split into focused
 * modules. This file
 * remains as a one-line re-export so existing callers don't need to
 * change their import path.
 *
 * New code should import from `@/src/services/indexing` directly.
 *
 * See the tree-sitter implementation under src/services/indexing/.
 */

export { IndexingService } from "./indexing";
export type { IndexRunResult } from "./indexing";
