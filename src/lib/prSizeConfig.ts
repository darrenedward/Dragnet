import { chmod, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHUNK_LINE_CAP,
  MIN_USEFUL_CHUNK_LINES,
} from "../services/largePrReview/chunker";
import {
  NORMAL_MAX_LINES,
  NORMAL_MAX_CODE_FILES,
  OVERSIZED_LINES,
  OVERSIZED_CODE_FILES,
} from "../services/largePrReview/manifest";

/**
 * Configurable PR-size limits for the review engine.
 *
 * Source of truth for **live** tier/chunk/concurrency decisions is
 * `readLimits()` → `.dragnet/review-limits.json` (or DEFAULT_LIMITS when
 * no file). Hardcoded constants in chunker/manifest are defaults only
 * and feed DEFAULT_LIMITS; runtime call sites must not bypass this
 * module for policy numbers (use tierThresholdsFromLimits /
 * chunkOptionsFromLimits).
 *
 * Why a JSON file vs DB or env vars:
 *  - mirrors the `llm-presets.json` pattern (atomic write + chmod 0600)
 *  - easy to inspect/back up, single-user dev so no network hop needed
 *  - env vars can't be edited from the UI without a restart
 *
 * Caching:
 *  - The chunker + manifest read limits once per scan via `readLimits()`.
 *    A `globalThis` guard caches across hot-reloads in dev (mirrors
 *    `prisma.ts` / `llmClient.ts`).
 *  - `clearLimitsCache()` is called by the PUT route after save so the
 *    next scan picks up new values without a server restart.
 *
 * First-run: returns DEFAULT_LIMITS in memory; the file appears on
 * disk only when the user saves via the Settings UI (mirrors llmPresets).
 *
 * Metrics are **PR diff lines + code-file counts**, not authoring LOC caps.
 */

export interface ReviewLimits {
  /** Maximum number of scans a queue worker may run concurrently. */
  maxConcurrentScans?: number;
  /** Max lines per chunk (default floor; effective cap = max with normalMaxLines). */
  chunkLineCap: number;
  /** Min lines for a chunk to be worth its own LLM call. */
  minUsefulChunkLines: number;
  /** GROUPED tier threshold (code diff lines). */
  normalMaxLines: number;
  /** GROUPED tier file threshold (code files). */
  normalMaxCodeFiles: number;
  /** OVERSIZED tier threshold (code diff lines). */
  oversizedLines: number;
  /** OVERSIZED tier file threshold (code files). */
  oversizedCodeFiles: number;
  /**
   * Tail-skip cap: when > 0, only the top N code files (sorted by line
   * count, largest first) reach the chunker. Files beyond N are dropped
   * with a `systemWarn`. 0 = review everything (current behavior).
   */
  maxFilesPerReview: number;
}

/** Tier thresholds subset passed into manifest/assertTier. */
export interface LimitsTierThresholds {
  normalMaxLines: number;
  normalMaxCodeFiles: number;
  oversizedLines: number;
  oversizedCodeFiles: number;
}

/** Chunk options subset passed into chunkDiff (with effective cap applied). */
export interface LimitsChunkOptions {
  chunkLineCap: number;
  minUsefulChunkLines: number;
}

/**
 * Paths are computed lazily so tests can swap `process.cwd()` to a temp
 * dir. Computing at module-load would freeze the path before tests can
 * redirect it.
 */
function limitsDir(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), ".dragnet");
}
function limitsPath(): string {
  return join(limitsDir(), "review-limits.json");
}
function limitsTmp(): string {
  return join(limitsDir(), "review-limits.json.tmp");
}

/**
 * Shipped defaults — parity with engine constants (chunker/manifest).
 * GET `/api/llm/review-limits` returns these as `defaults`; UI Reset uses
 * that server payload. Live installs may override via Settings
 * (`.dragnet/review-limits.json`); next scan picks them up without restart.
 *
 * Tier envelope: normal < 800 lines / 40 code files; oversized > 3000 / 100.
 * chunkLineCap 600 is a floor; effective chunk cap = max(chunkLineCap, normalMaxLines).
 */
export const DEFAULT_LIMITS: ReviewLimits = {
  maxConcurrentScans: 1,
  chunkLineCap: CHUNK_LINE_CAP,
  minUsefulChunkLines: MIN_USEFUL_CHUNK_LINES,
  normalMaxLines: NORMAL_MAX_LINES,
  normalMaxCodeFiles: NORMAL_MAX_CODE_FILES,
  oversizedLines: OVERSIZED_LINES,
  oversizedCodeFiles: OVERSIZED_CODE_FILES,
  maxFilesPerReview: 0,
};

const globalForLimits = globalThis as unknown as {
  __reviewLimitsCache?: ReviewLimits | null;
  __reviewLimitsInitialized?: boolean;
};

/**
 * Read current limits. First call reads from disk; subsequent calls hit
 * the in-memory cache.
 *
 * Returns DEFAULT_LIMITS on any read/parse failure — review engine must
 * never crash because the user's JSON is malformed. The error is logged
 * once per process so the operator notices but doesn't get spammed.
 */
export function readLimits(): ReviewLimits {
  if (globalForLimits.__reviewLimitsInitialized) {
    return globalForLimits.__reviewLimitsCache ?? DEFAULT_LIMITS;
  }

  let parsed: ReviewLimits | null = null;
  if (existsSync(limitsPath())) {
    try {
      const raw = readFileSync(limitsPath(), "utf8");
      const obj = JSON.parse(raw);
      parsed = coerceLimits(obj);
    } catch (err) {
      console.warn(
        "[prSizeConfig] review-limits.json unreadable, using defaults:",
        err,
      );
    }
  }

  const result = parsed ?? DEFAULT_LIMITS;
  globalForLimits.__reviewLimitsCache = result;
  globalForLimits.__reviewLimitsInitialized = true;

  return result;
}

/**
 * Persist new limits. Atomic (.tmp → rename → chmod 0600), then
 * invalidates the cache so the next read picks up new values.
 */
export async function saveLimits(next: ReviewLimits): Promise<void> {
  await writeLimitsToDisk(next);
  globalForLimits.__reviewLimitsCache = next;
  globalForLimits.__reviewLimitsInitialized = true;
}

/**
 * Drop the in-memory cache. The save route calls this so other modules
 * reading limits in the same process pick up the new values on next call.
 * Also useful for tests that swap the file directly.
 */
export function clearLimitsCache(): void {
  globalForLimits.__reviewLimitsCache = null;
  globalForLimits.__reviewLimitsInitialized = false;
}

/**
 * Map ReviewLimits → tier thresholds for buildDiffManifest / assertTier.
 * Live call sites must use this (or equivalent fields from readLimits())
 * rather than bare engine constants.
 */
export function tierThresholdsFromLimits(
  limits: ReviewLimits = readLimits(),
): LimitsTierThresholds {
  return {
    normalMaxLines: limits.normalMaxLines,
    normalMaxCodeFiles: limits.normalMaxCodeFiles,
    oversizedLines: limits.oversizedLines,
    oversizedCodeFiles: limits.oversizedCodeFiles,
  };
}

/**
 * Effective chunk line cap: max(chunkLineCap, normalMaxLines) so a
 * normal-tier PR always fits in a single chunk.
 */
export function effectiveChunkLineCap(
  limits: ReviewLimits = readLimits(),
): number {
  return Math.max(limits.chunkLineCap, limits.normalMaxLines);
}

/**
 * Map ReviewLimits → chunkDiff options with effective cap applied.
 */
export function chunkOptionsFromLimits(
  limits: ReviewLimits = readLimits(),
): LimitsChunkOptions {
  return {
    chunkLineCap: effectiveChunkLineCap(limits),
    minUsefulChunkLines: limits.minUsefulChunkLines,
  };
}

async function writeLimitsToDisk(limits: ReviewLimits): Promise<void> {
  const dir = limitsDir();
  const target = limitsPath();
  const tmp = limitsTmp();
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(limits, null, 2);
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
}

/**
 * Coerce an unknown parsed value into a valid ReviewLimits. Missing
 * fields fall back to defaults; non-numeric values are also defaulted.
 * Never throws — bad input yields defaults, the engine keeps running.
 */
function coerceLimits(input: unknown): ReviewLimits | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const num = (key: keyof ReviewLimits): number | undefined => {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    return v;
  };
  return {
    maxConcurrentScans: Math.max(1, Math.floor(num("maxConcurrentScans") ?? DEFAULT_LIMITS.maxConcurrentScans!)),
    chunkLineCap: num("chunkLineCap") ?? DEFAULT_LIMITS.chunkLineCap,
    minUsefulChunkLines: num("minUsefulChunkLines") ?? DEFAULT_LIMITS.minUsefulChunkLines,
    normalMaxLines: num("normalMaxLines") ?? DEFAULT_LIMITS.normalMaxLines,
    normalMaxCodeFiles: num("normalMaxCodeFiles") ?? DEFAULT_LIMITS.normalMaxCodeFiles,
    oversizedLines: num("oversizedLines") ?? DEFAULT_LIMITS.oversizedLines,
    oversizedCodeFiles: num("oversizedCodeFiles") ?? DEFAULT_LIMITS.oversizedCodeFiles,
    maxFilesPerReview: num("maxFilesPerReview") ?? DEFAULT_LIMITS.maxFilesPerReview,
  };
}

export function reviewLimitsPath(): string {
  return limitsPath();
}
