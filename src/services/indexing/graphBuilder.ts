/**
 * Graph builder — resolves RawCalls into EdgeRows once all symbols in a
 * repo are known.
 *
 * Edges are written with `kind = "CALLS"` (uppercase) per PRD §11.2.
 * This is the normalization fix for the original `kind: "call"` casing
 * bug flagged in `prd.md:339` and `roadmap.md:75` — both writer (here)
 * and readers (`getCallers` in reviewService.ts) must agree.
 *
 * The lookup is intentionally fuzzy: a call to `foo.bar()` may resolve
 * to a symbol stored as `bar`, `foo.bar`, or `Class.bar`. We try
 * filePath-scoped first, then dotted-suffix match, then bare name.
 */

import type { RawCall } from "./types";

export interface EdgeRow {
  id: string;
  repoId: string;
  fromId: string;
  toId: string | null;
  toRaw: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface SymbolLookupEntry {
  id: string;
  filePath: string;
  name: string;
}

/**
 * Builds a lookup keyed on both `filePath|name` and bare `name`. If a name
 * collides across files, the bare-key form keeps the last write — that's
 * acceptable for v1; better than no resolution.
 */
export function buildSymbolLookup(
  symbols: SymbolLookupEntry[],
  excludeFilePaths: string[] = [],
): Record<string, string> {
  const map: Record<string, string> = {};
  const exclude = new Set(excludeFilePaths);
  for (const sym of symbols) {
    if (exclude.has(sym.filePath)) continue;
    map[`${sym.filePath}|${sym.name}`] = sym.id;
    map[sym.name] = sym.id;
  }
  return map;
}

/**
 * Resolves a list of RawCalls (from one or many files) into edge rows.
 * Each call tries three lookup strategies in order:
 *   1. `${call.filePath}|${call.fromSymbolName}` — same-file caller
 *   2. dotted/`::` suffix match on `call.toRaw` — method calls
 *   3. bare `call.toRaw` — global fallback
 *
 * Calls with no resolvable caller symbol are dropped (no fromId to attach).
 * Calls with no resolvable callee still produce an edge with `toId: null`
 * — these are the "unresolved edges" PRD §11.2 mentions.
 */
export function resolveCallsToEdges(
  calls: Array<RawCall & { filePath: string }>,
  lookup: Record<string, string>,
  repoId: string,
  startEdgeIndex = 1,
): { edges: EdgeRow[]; nextIndex: number } {
  const hasOwn = (k: string) =>
    Object.prototype.hasOwnProperty.call(lookup, k);
  const lookupFn = (k: string): string | undefined =>
    hasOwn(k) ? lookup[k] : undefined;

  // Optimized suffix lookup: replaces O(C*S) full-scan with O(S) pre-index.
  // We map the last segment of dotted (a.b) or namespaced (a::b) keys to
  // their symbol IDs. This matches the "fuzzy" method resolution logic
  // without the quadratic performance cost.
  const dotSuffixMap = new Map<string, string>();
  const colonSuffixMap = new Map<string, string>();

  for (const k in lookup) {
    if (!hasOwn(k)) continue;

    const lastDot = k.lastIndexOf(".");
    if (lastDot !== -1) {
      const suffix = k.substring(lastDot + 1);
      if (!dotSuffixMap.has(suffix)) dotSuffixMap.set(suffix, lookup[k]);
    }

    const lastColon = k.lastIndexOf("::");
    if (lastColon !== -1) {
      const suffix = k.substring(lastColon + 2);
      if (!colonSuffixMap.has(suffix)) colonSuffixMap.set(suffix, lookup[k]);
    }
  }

  const edges: EdgeRow[] = [];
  let edgeIndex = startEdgeIndex;

  for (const call of calls) {
    const fromSymbolId =
      lookupFn(`${call.filePath}|${call.fromSymbolName}`) ||
      lookupFn(call.fromSymbolName);
    if (!fromSymbolId) continue;

    let toSymbolId = lookupFn(`${call.filePath}|${call.toRaw}`);
    if (!toSymbolId) {
      // Try suffix matches (method calls) from the pre-indexed maps
      toSymbolId = dotSuffixMap.get(call.toRaw) || colonSuffixMap.get(call.toRaw);
    }
    if (!toSymbolId) {
      toSymbolId = lookupFn(call.toRaw);
    }

    edges.push({
      id: `edge-${repoId}-${edgeIndex++}`,
      repoId,
      fromId: fromSymbolId,
      toId: toSymbolId || null,
      toRaw: call.toRaw,
      kind: "CALLS",
      filePath: call.filePath,
      line: call.line,
    });
  }

  return { edges, nextIndex: edgeIndex };
}
