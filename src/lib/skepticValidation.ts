import type { SkepticSettings } from "./skepticConfig";

/**
 * Validate a PUT body for `/api/llm/skeptic`. Only `{enabled: boolean}`
 * is accepted — future skeptic config fields (per-repo overrides, same-model
 * guard, etc.) will extend this.
 *
 * Throws Error with a descriptive message on any invalid input. Used by
 * the API route so client-side bugs can't corrupt the file.
 */
export function validateSkeptic(input: unknown): SkepticSettings {
  if (!input || typeof input !== "object") {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    throw new Error("`enabled` must be a boolean.");
  }
  return { enabled: obj.enabled };
}
