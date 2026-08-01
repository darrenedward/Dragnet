import {
  coerceLogVerbosity,
  type LogVerbositySettings,
  LOG_VERBOSITY_LEVELS,
} from "./logVerbosityCore";

/**
 * Validate PUT body for /api/llm/log-verbosity.
 * Throws Error with a descriptive message on invalid input.
 */
export function validateLogVerbosity(input: unknown): LogVerbositySettings {
  if (!input || typeof input !== "object") {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  const level = coerceLogVerbosity(obj.level);
  if (!level) {
    throw new Error(
      `level must be one of: ${LOG_VERBOSITY_LEVELS.join(", ")}.`,
    );
  }
  return { level };
}
