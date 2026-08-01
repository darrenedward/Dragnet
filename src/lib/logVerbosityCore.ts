/**
 * Pure log-verbosity types + filter matrix (no filesystem).
 *
 * Safe for "use client" imports — disk IO lives in logVerbosity.ts.
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
