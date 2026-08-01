import { chmod, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator log verbosity (Settings UI only).
 *
 * Source of truth: `.dragnet/log-verbosity.json` — same family as
 * review-limits / skeptic-settings (atomic write, mode 0600, globalThis cache).
 *
 * Levels are a minimum-level filter:
 *   Debug < User < Warn < Error
 * A line emits when its rank >= the configured minimum.
 *
 * ReviewLog line levels map into this scale:
 *   tool_call → debug, info → user, warn → warn, error → error
 */

export const LOG_VERBOSITY_LEVELS = ["user", "warn", "error", "debug"] as const;

export type LogVerbosity = (typeof LOG_VERBOSITY_LEVELS)[number];

/** Levels that appear on console lines or ReviewLog.level. */
export type LogLineLevel =
  | LogVerbosity
  | "info"
  | "tool_call"
  | (string & {});

export interface LogVerbositySettings {
  level: LogVerbosity;
}

export const DEFAULT_LOG_VERBOSITY: LogVerbosity = "user";

export const DEFAULT_LOG_VERBOSITY_SETTINGS: LogVerbositySettings = {
  level: DEFAULT_LOG_VERBOSITY,
};

/** window event after Settings saves a new verbosity (UI listeners refetch). */
export const LOG_VERBOSITY_CHANGED_EVENT = "dragnet:log-verbosity-changed";

const VERBOSITY_RANK: Record<LogVerbosity, number> = {
  debug: 0,
  user: 1,
  warn: 2,
  error: 3,
};

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

export function verbosityRank(level: LogVerbosity): number {
  return VERBOSITY_RANK[level];
}

/**
 * Map a stored/console line level onto the verbosity rank scale.
 * Unknown levels default to user/info so they stay visible at default User.
 */
export function lineLevelRank(level: LogLineLevel): number {
  const key = String(level ?? "").toLowerCase();
  if (key === "tool_call" || key === "debug") return VERBOSITY_RANK.debug;
  if (key === "info" || key === "user" || key === "log") return VERBOSITY_RANK.user;
  if (key === "warn" || key === "warning") return VERBOSITY_RANK.warn;
  if (key === "error") return VERBOSITY_RANK.error;
  return VERBOSITY_RANK.user;
}

/** True when a line at `lineLevel` should emit under minimum `minLevel`. */
export function shouldEmitLog(minLevel: LogVerbosity, lineLevel: LogLineLevel): boolean {
  return lineLevelRank(lineLevel) >= verbosityRank(minLevel);
}

/** Alias for UI/ReviewLog filtering — same matrix as shouldEmitLog. */
export function isLogLineVisible(minLevel: LogVerbosity, lineLevel: LogLineLevel): boolean {
  return shouldEmitLog(minLevel, lineLevel);
}

export function coerceLogVerbosity(input: unknown): LogVerbosity | null {
  if (typeof input !== "string") return null;
  const v = input.trim().toLowerCase();
  if ((LOG_VERBOSITY_LEVELS as readonly string[]).includes(v)) {
    return v as LogVerbosity;
  }
  return null;
}

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
