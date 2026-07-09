import type { SkepticSettings, SkepticSeverity } from "./skepticConfig";
import { SKEPTIC_VALID_SEVERITIES } from "./skepticConfig";

/**
 * Validate a PUT body for `/api/llm/skeptic`. Strict on shape — only the
 * fields documented in SkepticSettings are accepted, and each must be the
 * right type. Defaults are NOT applied here: the client must send every
 * field it wants persisted. This keeps the contract honest and avoids
 * surprise merges from stale UI state.
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
  const gateSeverity = parseSeverityArray(obj.gateSeverity);
  const gateMinConfidence = parseConfidence(obj.gateMinConfidence);
  const gateCategories = parseStringArray(obj.gateCategories, "gateCategories");
  if (typeof obj.skipDeterministic !== "boolean") {
    throw new Error("`skipDeterministic` must be a boolean.");
  }
  return {
    enabled: obj.enabled,
    gateSeverity,
    gateMinConfidence,
    gateCategories,
    skipDeterministic: obj.skipDeterministic,
  };
}

function parseSeverityArray(raw: unknown): SkepticSeverity[] {
  if (!Array.isArray(raw)) {
    throw new Error("`gateSeverity` must be an array of severity strings.");
  }
  const out: SkepticSeverity[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !SKEPTIC_VALID_SEVERITIES.has(item)) {
      throw new Error(
        `\`gateSeverity\` has an invalid entry: ${JSON.stringify(item)}. Must be one of blocker, warning, suggestion.`,
      );
    }
    out.push(item as SkepticSeverity);
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function parseConfidence(raw: unknown): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error("`gateMinConfidence` must be a number in [0, 1].");
  }
  if (raw < 0 || raw > 1) {
    throw new Error("`gateMinConfidence` must be between 0 and 1 inclusive.");
  }
  return raw;
}

function parseStringArray(raw: unknown, fieldName: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`\`${fieldName}\` must be an array of strings.`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(
        `\`${fieldName}\` has an invalid entry: ${JSON.stringify(item)}.`,
      );
    }
    out.push(item.trim());
  }
  return out;
}
