import type { DeterministicFinding } from "./types";

/** Default install for Tier 2 container checks. */
export const DEFAULT_INSTALL_COMMAND = "npm install";

/**
 * Default quality-gate command: typecheck + lint.
 * Build is optional per-repo; full e2e/unit suites are not the default gate.
 */
export const DEFAULT_TEST_COMMAND = "npm run typecheck && npm run lint";

export type HostTier1Repo = {
  path?: string | null;
  cloneUrl?: string | null;
  localPath?: string | null;
};

/**
 * Host Tier 1 (tsc/eslint on the server checkout) only when there is a
 * meaningful local path and the repo is not remote/volume-backed.
 * Remote/volume repos use Tier 2 container install + configured checks only.
 */
export function shouldRunHostTier1(repo: HostTier1Repo | null | undefined): boolean {
  if (!repo?.path) return false;
  // Volume-backed container mode — source of truth is the Docker volume.
  if (repo.localPath === "/workspace") return false;
  // Remote clone URL → Tier 2 only (avoid host/container double-run and
  // stale empty host mirrors after redeploy).
  if (repo.cloneUrl) return false;
  return true;
}

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
