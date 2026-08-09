import type { DeterministicFinding } from "./types";

/** Default install for Tier 2 container checks. */
export const DEFAULT_INSTALL_COMMAND = "npm install";

/**
 * Default quality-gate command: typecheck + lint.
 * Build is optional per-repo; full e2e/unit suites are not the default gate.
 */
export const DEFAULT_TEST_COMMAND = "npm run typecheck && npm run lint";
const BROAD_TEST_COMMAND = /\b(?:npm\s+(?:run\s+)?test|vitest|jest|playwright|cypress|pytest)\b/i;
const EXTERNAL_DEPENDENCY_FAILURE = /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|connection\s+refused|could not connect|failed to connect|connection timed out|missing (?:service|database|credentials?)|service unavailable|localhost:\d+|127\.0\.0\.1:\d+)/i;

/** Environmental failures are coverage gaps, not defects in the reviewed source. */
export function isExternalDependencyFailure(output: string): boolean {
  return EXTERNAL_DEPENDENCY_FAILURE.test(output);
}

export type QualityCommandOptions = {
  /** A repository-specific command already verified to be service-free. */
  configuredCommand?: string | null;
  /** Package scripts from the reviewed tip, when it is a Node repository. */
  scripts?: Record<string, string> | null;
};

/**
 * Resolve the command used by the deterministic quality gate.
 *
 * The default is deliberately typecheck + lint. A repository without a
 * typecheck script can opt into a verified build + lint command; there is no
 * fallback to a broad unit, integration, or end-to-end test suite.
 */
export function resolveQualityCommand(options: QualityCommandOptions = {}): string {
  const configured = options.configuredCommand?.trim();
  const scripts = options.scripts;
  const isDefault = !configured || configured === DEFAULT_TEST_COMMAND;
  if (!isDefault && !BROAD_TEST_COMMAND.test(configured)) return configured;

  // A non-Node repository may have an explicitly verified command such as
  // pytest. Without package metadata, preserve that explicit command; the
  // safe fallback applies when the default command is being resolved.
  if (!scripts) return configured || DEFAULT_TEST_COMMAND;
  if (scripts.typecheck) return DEFAULT_TEST_COMMAND;
  if (scripts.build) return "npm run build && npm run lint";
  return "npm run lint";
}

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

export function externalDependencySkip(source: "runner", command: string): DeterministicFinding {
  return {
    ...skippedFinding(source, `External dependency unavailable while running ${command}`),
    category: "External Dependency Skipped",
  };
}
