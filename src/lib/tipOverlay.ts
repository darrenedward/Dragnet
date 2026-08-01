/**
 * Tip overlay index — MVP A for PR tip review.
 *
 * Keep the cheap repo base index; before graph tools run, re-parse changed
 * files (and reasonable neighbors) at headSha into a scan-scoped overlay.
 * searchCodebase / getCallers / findSimilar query overlay first so tip-only
 * symbols are findable even when the volume HEAD stayed on main.
 *
 * Freshness for tools = overlay.headSha matches the scan head, not
 * "base index lastCommitHash equals volume HEAD."
 */

import crypto from "node:crypto";
import path from "node:path";

import { isSupportedFilePath } from "@/src/lib/treeSitter";
import {
  buildSymbolLookup,
  resolveCallsToEdges,
} from "@/src/services/indexing/graphBuilder";
import { parseFileSymbols } from "@/src/services/indexing/tsParser";
import type { RawCall } from "@/src/services/indexing/types";

export interface TipOverlaySymbol {
  id: string;
  repoId: string;
  filePath: string;
  name: string;
  kind: string;
  language: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  summary?: string | null;
}

export interface TipOverlayEdge {
  id: string;
  repoId: string;
  fromId: string;
  toId: string | null;
  toRaw: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface TipOverlay {
  headSha: string;
  repoId: string;
  /** Paths re-parsed into this overlay (changed + neighbors). */
  filePaths: readonly string[];
  symbols: readonly TipOverlaySymbol[];
  edges: readonly TipOverlayEdge[];
  builtAt: number;
}

export interface BaseSymbolRef {
  id: string;
  filePath: string;
  name: string;
}

export type TipOverlayReadFile = (repoRelativePath: string) => Promise<string | null>;

export interface EnsureTipOverlayOpts {
  repoId: string;
  headSha: string;
  /** PR changed paths (repo-relative). */
  changedFiles: readonly string[];
  /** Tip-bound reader (review tree / git show at head). */
  readFile: TipOverlayReadFile;
  /** Extra neighbor paths (same-dir / import targets) already known. */
  neighborFiles?: readonly string[];
  /**
   * Base-index symbols for edge resolution across overlay + base.
   * Overlay symbols win on name collisions in the lookup.
   */
  baseSymbols?: readonly BaseSymbolRef[];
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

const IMPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Deterministic symbol ID — same scheme as IndexingService so tip and base
 * IDs agree when path/kind/name/lineStart match.
 */
export function makeOverlaySymbolId(
  repoId: string,
  filePath: string,
  meta: { kind: string; name: string; lineStart: number },
): string {
  const seed = `${filePath}|${meta.kind}|${meta.name}|${meta.lineStart}`;
  const hash = crypto.createHash("md5").update(seed).digest("hex").slice(0, 12);
  return `sym-${repoId}-${hash}`;
}

/** True when overlay was built for this scan's head. */
export function isTipOverlayFresh(
  overlay: TipOverlay | null | undefined,
  headSha: string,
): boolean {
  if (!overlay || !headSha || !SHA_RE.test(headSha)) return false;
  return overlay.headSha === headSha;
}

export type TipOverlayFreshness =
  | { ok: true }
  | { ok: false; kind: "OVERLAY_REQUIRED" | "OVERLAY_STALE"; message: string };

/**
 * Tools-level freshness: overlay must match scan head. Independent of
 * whether the shared volume was left on main after webhook fetch.
 */
export function assertTipOverlayFresh(
  overlay: TipOverlay | null | undefined,
  headSha: string,
): TipOverlayFreshness {
  if (!headSha || !SHA_RE.test(headSha)) {
    return {
      ok: false,
      kind: "OVERLAY_REQUIRED",
      message: "Tip overlay freshness requires a scan head SHA.",
    };
  }
  if (!overlay) {
    return {
      ok: false,
      kind: "OVERLAY_REQUIRED",
      message: `Tip overlay missing for head ${headSha.slice(0, 7)} — graph tools would see base/main only.`,
    };
  }
  if (overlay.headSha !== headSha) {
    return {
      ok: false,
      kind: "OVERLAY_STALE",
      message: `Tip overlay is stale — built for ${overlay.headSha.slice(0, 7)}, scan head is ${headSha.slice(0, 7)}.`,
    };
  }
  return { ok: true };
}

export function formatTipOverlayLog(overlay: TipOverlay): string {
  return (
    `Tip overlay — head=${overlay.headSha} files=${overlay.filePaths.length} ` +
    `symbols=${overlay.symbols.length} edges=${overlay.edges.length}`
  );
}

/** Collect relative import/require targets from source text. */
export function extractRelativeImportSpecs(code: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const re of [IMPORT_FROM_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1];
      if (!seen.has(spec)) {
        seen.add(spec);
        out.push(spec);
      }
    }
  }
  return out;
}

/**
 * Resolve a relative import specifier to candidate repo-relative paths
 * (with common TS/JS extensions and index files).
 */
export function resolveImportCandidates(
  fromFile: string,
  spec: string,
): string[] {
  if (!spec.startsWith(".")) return [];
  const dir = path.posix.dirname(fromFile.replace(/\\/g, "/"));
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  if (joined.startsWith("..")) return [];
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  const candidates: string[] = [];
  if (path.posix.extname(joined)) {
    candidates.push(joined);
  } else {
    for (const ext of exts) candidates.push(joined + ext);
    for (const ext of exts) candidates.push(`${joined}/index${ext}`);
  }
  return candidates;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isIndexablePath(p: string): boolean {
  return isSupportedFilePath(p);
}

/**
 * Build or refresh a tip overlay for this scan head from tip file bytes.
 */
export async function ensureTipOverlay(
  opts: EnsureTipOverlayOpts,
): Promise<TipOverlay> {
  const { repoId, headSha } = opts;
  if (!headSha || !SHA_RE.test(headSha)) {
    throw new Error(`ensureTipOverlay: invalid headSha ${headSha}`);
  }
  if (!repoId) {
    throw new Error("ensureTipOverlay: repoId required");
  }

  const changedSet = new Set<string>();
  for (const f of opts.changedFiles) {
    const n = normalizePath(f);
    if (n && isIndexablePath(n)) changedSet.add(n);
  }
  const seedPaths = new Set<string>(changedSet);
  for (const f of opts.neighborFiles ?? []) {
    const n = normalizePath(f);
    if (n && isIndexablePath(n)) seedPaths.add(n);
  }

  // Read seeds; expand relative imports only from PR-changed files (1-hop neighbors).
  const contentByPath = new Map<string, string>();
  const queue = [...seedPaths];
  const queued = new Set(queue);

  while (queue.length > 0) {
    const filePath = queue.shift()!;
    let code: string | null = null;
    try {
      code = await opts.readFile(filePath);
    } catch {
      code = null;
    }
    if (typeof code !== "string") continue;
    contentByPath.set(filePath, code);

    if (!changedSet.has(filePath)) continue;
    for (const spec of extractRelativeImportSpecs(code)) {
      for (const cand of resolveImportCandidates(filePath, spec)) {
        if (!isIndexablePath(cand) || queued.has(cand)) continue;
        queued.add(cand);
        queue.push(cand);
      }
    }
  }

  const symbols: TipOverlaySymbol[] = [];
  const rawCalls: Array<RawCall & { filePath: string }> = [];
  const overlayLookupEntries: Array<{ id: string; filePath: string; name: string }> = [];

  for (const [filePath, code] of contentByPath) {
    try {
      const parsed = await parseFileSymbols(repoId, filePath, code);
      for (const meta of parsed.symbols) {
        const id = makeOverlaySymbolId(repoId, filePath, meta);
        symbols.push({
          id,
          repoId,
          filePath,
          name: meta.name,
          kind: meta.kind,
          language: meta.language,
          lineStart: meta.lineStart,
          lineEnd: meta.lineEnd,
          signature: meta.signature || null,
        });
        overlayLookupEntries.push({ id, filePath, name: meta.name });
      }
      for (const call of parsed.rawCalls) {
        rawCalls.push({ ...call, filePath });
      }
    } catch (err) {
      console.warn(`[tipOverlay] failed parsing ${filePath}`, err);
    }
  }

  // Overlay symbols first so tip names win over base on collisions.
  const lookup = buildSymbolLookup([
    ...overlayLookupEntries,
    ...(opts.baseSymbols ?? []),
  ]);
  // Re-apply overlay entries last to guarantee tip preference.
  for (const s of overlayLookupEntries) {
    lookup[`${s.filePath}|${s.name}`] = s.id;
    lookup[s.name] = s.id;
  }

  const { edges: resolved } = resolveCallsToEdges(rawCalls, lookup, repoId);
  const edges: TipOverlayEdge[] = resolved.map((e) => ({
    id: e.id,
    repoId: e.repoId,
    fromId: e.fromId,
    toId: e.toId,
    toRaw: e.toRaw,
    kind: e.kind,
    filePath: e.filePath,
    line: e.line,
  }));

  const filePaths = [...contentByPath.keys()].sort();
  return {
    headSha,
    repoId,
    filePaths,
    symbols,
    edges,
    builtAt: Date.now(),
  };
}

/** Name-contains search over tip overlay symbols. */
export function searchTipOverlay(
  overlay: TipOverlay,
  query: string,
  take = 10,
): TipOverlaySymbol[] {
  const q = (query || "").trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const hits = overlay.symbols.filter((s) => s.name.toLowerCase().includes(lower));
  return hits.slice(0, take);
}

export interface OverlayCallerHit {
  callerName: string;
  filePath: string;
  line: number;
  fromId: string;
}

/** CALLS edges targeting symbolId from the tip overlay. */
export function getTipOverlayCallers(
  overlay: TipOverlay,
  symbolId: string,
): OverlayCallerHit[] {
  if (!symbolId) return [];
  const nameById = new Map(overlay.symbols.map((s) => [s.id, s.name]));
  const hits: OverlayCallerHit[] = [];
  for (const e of overlay.edges) {
    if (e.kind !== "CALLS" || e.toId !== symbolId) continue;
    hits.push({
      callerName: nameById.get(e.fromId) || e.fromId,
      filePath: e.filePath,
      line: e.line,
      fromId: e.fromId,
    });
  }
  return hits;
}

/**
 * Tip-generation "similar": name/signature contains match over overlay.
 * Prefer this over base embeddings when the query names tip symbols.
 */
export function findTipOverlaySimilar(
  overlay: TipOverlay,
  query: string,
  limit = 5,
): TipOverlaySymbol[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const scored = overlay.symbols
    .map((s) => {
      const name = s.name.toLowerCase();
      const sig = (s.signature || "").toLowerCase();
      let score = 0;
      if (name === q) score = 3;
      else if (name.includes(q) || q.includes(name)) score = 2;
      else if (sig.includes(q)) score = 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return scored.slice(0, limit).map((x) => x.s);
}

export type GraphSymbolHit = {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  summary?: string | null;
  /** Present when the hit came from tip overlay. */
  source?: "tip" | "base";
};

/**
 * Overlay-first merge for searchCodebase. Tip hits win on path+name+kind.
 */
export function mergeSymbolSearchResults(
  overlayHits: readonly GraphSymbolHit[],
  baseHits: readonly GraphSymbolHit[],
  take = 10,
): GraphSymbolHit[] {
  const out: GraphSymbolHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...overlayHits, ...baseHits]) {
    const key = `${hit.filePath}|${hit.name}|${hit.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= take) break;
  }
  return out;
}

/**
 * Overlay-first callers. Tip edges first; base edges append when not
 * duplicate (same fromId + line).
 */
export function mergeCallerResults(
  overlayHits: readonly OverlayCallerHit[],
  baseHits: readonly OverlayCallerHit[],
): OverlayCallerHit[] {
  const out: OverlayCallerHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...overlayHits, ...baseHits]) {
    const key = `${hit.fromId}|${hit.filePath}|${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
