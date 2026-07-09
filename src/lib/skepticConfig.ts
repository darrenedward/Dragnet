import { chmod, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skeptic pass configuration.
 *
 * Source of truth is `.dragnet/skeptic-settings.json` at the project root.
 * Mirrors the `prSizeConfig.ts` / `llm-presets.json` pattern: atomic write,
 * mode 0600, globalThis cache that survives Next.js hot reloads.
 *
 * When `enabled` is true AND a fallback chat model is configured, each PR
 * scan runs an adversarial adjudication pass against the fallback model
 * after the primary agentic loop completes. See
 * `src/services/findingVerifier/skepticPass.ts` for the pass logic and
 * `reviewService.ts` for the wiring.
 *
 * Gating (issue #71): the gate fields decide which findings the fallback
 * model adjudicates. Findings that don't clear the gate keep their existing
 * verification state — they're never sent to the fallback, never receive a
 * skeptic verdict. Deterministic findings (tsc / eslint / runner) bypass
 * the gate entirely when `skipDeterministic` is on; they're ground truth,
 * not candidates for adjudication.
 *
 * First-run: returns DEFAULT_SKEPTIC in memory; the file appears on disk
 * only when the user saves via the Settings UI.
 */

export type SkepticSeverity = "blocker" | "warning" | "suggestion";

export interface SkepticSettings {
  /** Master switch for the skeptic pass. Defaults to off. */
  enabled: boolean;
  /**
   * Severity levels eligible for adjudication. Defaults to blocker-only so
   * the fallback spends its budget where it matters most. Empty array
   * disables the pass in effect (nothing clears the gate).
   */
  gateSeverity: SkepticSeverity[];
  /**
   * Minimum LLM confidence (0..1) for a finding to be adjudicated. Findings
   * with no confidence value pass the gate — absence isn't evidence of low
   * confidence, and many findings ship without a numeric score. Defaults
   * to 0.7.
   */
  gateMinConfidence: number;
  /**
   * Categories eligible for adjudication. Case-insensitive comparison
   * against the finding's category. Defaults to Security + Correctness.
   * Empty array disables the pass in effect.
   */
  gateCategories: string[];
  /**
   * When true, deterministic findings (source = tsc | eslint | runner)
   * never reach the fallback model. They're ground truth from a tool the
   * user trusts, not candidates for LLM adjudication. Defaults to true.
   */
  skipDeterministic: boolean;
}

function skepticDir(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), ".dragnet");
}
function skepticPath(): string {
  return join(skepticDir(), "skeptic-settings.json");
}
function skepticTmp(): string {
  return join(skepticDir(), "skeptic-settings.json.tmp");
}

export const DEFAULT_SKEPTIC: SkepticSettings = {
  enabled: false,
  gateSeverity: ["blocker"],
  gateMinConfidence: 0.7,
  gateCategories: ["Security", "Correctness"],
  skipDeterministic: true,
};

export const SKEPTIC_VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "blocker",
  "warning",
  "suggestion",
]);

const globalForSkeptic = globalThis as unknown & {
  __skepticSettingsCache?: SkepticSettings | null;
  __skepticSettingsInitialized?: boolean;
};

/**
 * Read current skeptic settings. First call reads from disk; subsequent
 * calls hit the in-memory cache. Returns DEFAULT_SKEPTIC on any read/parse
 * failure — the scan engine must never crash because the user's JSON is
 * malformed. The error is logged once per process.
 */
export function readSkeptic(): SkepticSettings {
  if (globalForSkeptic.__skepticSettingsInitialized) {
    return globalForSkeptic.__skepticSettingsCache ?? DEFAULT_SKEPTIC;
  }

  let parsed: SkepticSettings | null = null;
  if (existsSync(skepticPath())) {
    try {
      const raw = readFileSync(skepticPath(), "utf8");
      const obj = JSON.parse(raw);
      parsed = coerceSkeptic(obj);
    } catch (err) {
      console.warn(
        "[skepticConfig] skeptic-settings.json unreadable, using defaults:",
        err,
      );
    }
  }

  const result = parsed ?? DEFAULT_SKEPTIC;
  globalForSkeptic.__skepticSettingsCache = result;
  globalForSkeptic.__skepticSettingsInitialized = true;

  return result;
}

/**
 * Persist new settings. Atomic (.tmp → rename → chmod 0600), then updates
 * the in-memory cache so subsequent reads in the same process pick up the
 * new values immediately.
 */
export async function saveSkeptic(next: SkepticSettings): Promise<void> {
  await writeSkepticToDisk(next);
  globalForSkeptic.__skepticSettingsCache = next;
  globalForSkeptic.__skepticSettingsInitialized = true;
}

/**
 * Drop the in-memory cache. The save route calls this so other modules
 * reading skeptic settings in the same process pick up new values on next
 * call. Also useful for tests that swap the file directly.
 */
export function clearSkepticCache(): void {
  globalForSkeptic.__skepticSettingsCache = null;
  globalForSkeptic.__skepticSettingsInitialized = false;
}

async function writeSkepticToDisk(settings: SkepticSettings): Promise<void> {
  const dir = skepticDir();
  const target = skepticPath();
  const tmp = skepticTmp();
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(settings, null, 2);
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
}

/**
 * Coerce unknown parsed JSON into SkepticSettings. Missing or invalid
 * `enabled` falls back to null (caller uses DEFAULT_SKEPTIC). Missing
 * gate fields inherit the default for that field — this keeps old #70
 * files (just `{enabled: true}`) loadable after the #71 upgrade without
 * a migration. Never throws.
 */
function coerceSkeptic(input: unknown): SkepticSettings | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") return null;

  const gateSeverity = coerceSeverityArray(obj.gateSeverity, DEFAULT_SKEPTIC.gateSeverity);
  const gateMinConfidence = coerceConfidence(obj.gateMinConfidence, DEFAULT_SKEPTIC.gateMinConfidence);
  const gateCategories = coerceStringArray(obj.gateCategories, DEFAULT_SKEPTIC.gateCategories);
  const skipDeterministic =
    typeof obj.skipDeterministic === "boolean"
      ? obj.skipDeterministic
      : DEFAULT_SKEPTIC.skipDeterministic;

  return {
    enabled: obj.enabled,
    gateSeverity,
    gateMinConfidence,
    gateCategories,
    skipDeterministic,
  };
}

function coerceSeverityArray(
  raw: unknown,
  fallback: SkepticSeverity[],
): SkepticSeverity[] {
  if (!Array.isArray(raw)) return fallback;
  const out: SkepticSeverity[] = [];
  for (const item of raw) {
    if (typeof item === "string" && SKEPTIC_VALID_SEVERITIES.has(item)) {
      out.push(item as SkepticSeverity);
    }
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function coerceConfidence(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return fallback;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

function coerceStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out;
}

export function skepticSettingsPath(): string {
  return skepticPath();
}
