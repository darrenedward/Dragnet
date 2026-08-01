import { chmod, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_LOG_VERBOSITY,
  DEFAULT_LOG_VERBOSITY_SETTINGS,
  coerceLogVerbosity,
  shouldEmitLog,
  type LogVerbosity,
  type LogVerbositySettings,
} from "./logVerbosityCore";

export {
  LOG_VERBOSITY_LEVELS,
  DEFAULT_LOG_VERBOSITY,
  DEFAULT_LOG_VERBOSITY_SETTINGS,
  LOG_VERBOSITY_CHANGED_EVENT,
  verbosityRank,
  lineLevelRank,
  shouldEmitLog,
  isLogLineVisible,
  coerceLogVerbosity,
  type LogVerbosity,
  type LogLineLevel,
  type LogVerbositySettings,
} from "./logVerbosityCore";

/**
 * Operator log verbosity (Settings UI only).
 *
 * Source of truth: `.dragnet/log-verbosity.json` — same family as
 * review-limits / skeptic-settings (atomic write, mode 0600, globalThis cache).
 *
 * Pure filter helpers live in logVerbosityCore.ts so client components can
 * import them without pulling node:fs into the browser bundle.
 */

function settingsDir(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), ".dragnet");
}
function settingsPath(): string {
  return join(settingsDir(), "log-verbosity.json");
}
function settingsTmp(): string {
  return join(settingsDir(), "log-verbosity.json.tmp");
}

const globalForLogVerbosity = globalThis as unknown as {
  __logVerbosityCache?: LogVerbositySettings | null;
  __logVerbosityInitialized?: boolean;
};

export function readLogVerbosity(): LogVerbositySettings {
  if (globalForLogVerbosity.__logVerbosityInitialized) {
    return globalForLogVerbosity.__logVerbosityCache ?? DEFAULT_LOG_VERBOSITY_SETTINGS;
  }

  let parsed: LogVerbositySettings | null = null;
  if (existsSync(settingsPath())) {
    try {
      const raw = readFileSync(settingsPath(), "utf8");
      const obj = JSON.parse(raw);
      parsed = coerceSettings(obj);
    } catch (err) {
      console.warn(
        "[logVerbosity] log-verbosity.json unreadable, using defaults:",
        err,
      );
    }
  }

  const result = parsed ?? DEFAULT_LOG_VERBOSITY_SETTINGS;
  globalForLogVerbosity.__logVerbosityCache = result;
  globalForLogVerbosity.__logVerbosityInitialized = true;
  return result;
}

export async function saveLogVerbosity(next: LogVerbositySettings): Promise<void> {
  const normalized: LogVerbositySettings = {
    level: coerceLogVerbosity(next.level) ?? DEFAULT_LOG_VERBOSITY,
  };
  await writeSettingsToDisk(normalized);
  globalForLogVerbosity.__logVerbosityCache = normalized;
  globalForLogVerbosity.__logVerbosityInitialized = true;
}

export function clearLogVerbosityCache(): void {
  globalForLogVerbosity.__logVerbosityCache = null;
  globalForLogVerbosity.__logVerbosityInitialized = false;
}

export function logVerbosityPath(): string {
  return settingsPath();
}

function coerceSettings(input: unknown): LogVerbositySettings | null {
  if (!input || typeof input !== "object") return null;
  const level = coerceLogVerbosity((input as Record<string, unknown>).level);
  if (!level) return null;
  return { level };
}

async function writeSettingsToDisk(settings: LogVerbositySettings): Promise<void> {
  const dir = settingsDir();
  const target = settingsPath();
  const tmp = settingsTmp();
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(settings, null, 2);
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
}

/**
 * Server console helper — filters by the persisted minimum level.
 * Prefer this over raw console.* for operator-facing noise control.
 */
export const dragnetLog = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("user", args),
  user: (...args: unknown[]) => emit("user", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

function emit(lineLevel: LogVerbosity, args: unknown[]): void {
  const min = readLogVerbosity().level;
  if (!shouldEmitLog(min, lineLevel)) return;
  if (lineLevel === "error") {
    console.error(...args);
    return;
  }
  if (lineLevel === "warn") {
    console.warn(...args);
    return;
  }
  if (lineLevel === "debug") {
    // Prefer console.debug so Docker/Dokploy log drivers can still tag it;
    // fall back path is console.log for environments that drop debug.
    if (typeof console.debug === "function") {
      console.debug(...args);
    } else {
      console.log(...args);
    }
    return;
  }
  console.log(...args);
}
