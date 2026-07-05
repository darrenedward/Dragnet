import type { DeterministicFinding } from "./types";

/**
 * Standard "checks skipped" finding — one per runner that couldn't run.
 * Severity is `info` (not warning) because missing tooling isn't a bug
 * in the scanned code, just a configuration gap.
 */
export function skippedFinding(
  source: "tsc" | "eslint" | "runner",
  message: string,
): DeterministicFinding {
  return {
    filename: "<tooling>",
    line: null,
    severity: "info",
    category: "Skipped",
    explanation: `[${source}] ${message}`,
    source,
  };
}
