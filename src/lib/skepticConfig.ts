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
 * First-run: returns DEFAULT_SKEPTIC in memory; the file appears on disk
 * only when the user saves via the Settings UI.
 */

export interface SkepticSettings {
  /** Master switch for the skeptic pass. Defaults to off. */
  enabled: boolean;
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
};

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
 * Coerce unknown parsed JSON into SkepticSettings. Missing or non-boolean
 * `enabled` falls back to the default (false). Never throws.
 */
function coerceSkeptic(input: unknown): SkepticSettings | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const enabled = obj.enabled;
  if (typeof enabled !== "boolean") return null;
  return { enabled };
}

export function skepticSettingsPath(): string {
  return skepticPath();
}
