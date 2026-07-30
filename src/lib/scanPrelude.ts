/**
 * Gated scan prelude — single seam before deterministic checks and the LLM.
 *
 * Returns pass or fail with a stable gate code. On fail, callers must not
 * start the LLM; surface the code to UI and command/skill.
 */

import { assertIndexFresh, type RepoForFreshness } from "./indexFreshness";
import type { ScanConfigurationIssue } from "./scanPreflight";

export type ScanGateCode =
  | "CONFIG_REQUIRED"
  | "INDEX_REQUIRED"
  | "INDEXING_IN_PROGRESS"
  | "STALE_INDEX"
  | "REINDEX_FAILED"
  | "DIFF_UNAVAILABLE"
  | "CLONE_FAILED";

export type ScanPreludePass = {
  ok: true;
  /** True when a STALE_INDEX path ran a successful reindex. */
  reindexed: boolean;
};

export type ScanPreludeFail = {
  ok: false;
  gate: ScanGateCode;
  message: string;
  httpStatus: number;
  repoId?: string;
  issues?: ScanConfigurationIssue[];
};

export type ScanPreludeResult = ScanPreludePass | ScanPreludeFail;

export interface ScanPreludeRepo extends RepoForFreshness {
  path?: string | null;
  cloneUrl?: string | null;
}

export interface ScanPreludeDeps {
  assertIndexFresh?: typeof assertIndexFresh;
  isIndexing?: (repoId: string) => boolean;
  /** Local-path incremental index. */
  indexFolder?: (repoId: string, path: string) => Promise<unknown>;
  /** Volume-aware remote fetch + index. */
  reindexRemote?: (repoId: string) => Promise<unknown>;
  getConfigurationIssues?: () => ScanConfigurationIssue[];
}

/**
 * Config + index freshness gates only (no diff/sync). Used by scan
 * execution before refreshPrFiles / deterministic / LLM.
 *
 * INDEX_REQUIRED: hard-block (or INDEXING_IN_PROGRESS if already running).
 * STALE_INDEX: auto-reindex via path or volume-aware remote fetch; fail
 * closed if reindex cannot run or throws.
 */
export async function runScanPrelude(
  repo: ScanPreludeRepo,
  deps: ScanPreludeDeps = {},
): Promise<ScanPreludeResult> {
  const getConfigurationIssues =
    deps.getConfigurationIssues ??
    (() => {
      // Lazy: scanPreflight → llmPresets → prisma; keep unit tests free of DB.
      const { getScanConfigurationIssues } = require("./scanPreflight") as typeof import("./scanPreflight");
      return getScanConfigurationIssues();
    });
  const checkFresh = deps.assertIndexFresh ?? assertIndexFresh;
  const isIndexing =
    deps.isIndexing ??
    ((repoId: string) => {
      // Lazy: avoid pulling Prisma into unit tests that inject all deps.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { IndexingService } = require("@/src/services/indexingService") as typeof import("@/src/services/indexingService");
      return IndexingService.isIndexing(repoId);
    });
  const indexFolder =
    deps.indexFolder ??
    (async (repoId: string, path: string) => {
      const { IndexingService } = await import("@/src/services/indexingService");
      return IndexingService.indexFolder(repoId, path);
    });
  const reindexRemote =
    deps.reindexRemote ??
    (async (repoId: string) => {
      const { enqueue } = await import("@/src/services/remoteFetchWorker");
      return enqueue(repoId);
    });
  const d = { getConfigurationIssues, assertIndexFresh: checkFresh, isIndexing, indexFolder, reindexRemote };

  const issues = d.getConfigurationIssues();
  if (issues.length > 0) {
    return {
      ok: false,
      gate: "CONFIG_REQUIRED",
      message: "Configure the chat and embedding providers before starting a PR review.",
      httpStatus: 400,
      issues,
    };
  }

  const freshness = await d.assertIndexFresh(repo);
  if (freshness.ok === true) {
    return { ok: true, reindexed: false };
  }

  if (freshness.ok === false && freshness.kind === "INDEX_REQUIRED") {
    if (d.isIndexing(repo.id)) {
      return {
        ok: false,
        gate: "INDEXING_IN_PROGRESS",
        message:
          "Indexing is currently running for this repo. Please wait for it to complete before running a PR review.",
        httpStatus: 409,
        repoId: repo.id,
      };
    }
    return {
      ok: false,
      gate: "INDEX_REQUIRED",
      message: freshness.message,
      httpStatus: 409,
      repoId: repo.id,
    };
  }

  // STALE_INDEX — must reindex; volume-only repos use remote fetch worker.
  try {
    if (repo.path) {
      await d.indexFolder(repo.id, repo.path);
      return { ok: true, reindexed: true };
    }
    if (repo.cloneUrl) {
      // remoteFetchWorker.enqueue returns null when a fetch is already in
      // flight — never treat that as a successful reindex or scans proceed
      // against a still-stale index.
      const remoteResult = await d.reindexRemote(repo.id);
      if (remoteResult === null) {
        return {
          ok: false,
          gate: "INDEXING_IN_PROGRESS",
          message:
            "A remote fetch/reindex is already running for this repo. Please wait for it to complete before running a PR review.",
          httpStatus: 409,
          repoId: repo.id,
        };
      }
      return { ok: true, reindexed: true };
    }
    return {
      ok: false,
      gate: "REINDEX_FAILED",
      message:
        "Index is stale but this repository has neither a local path nor a clone URL to reindex from.",
      httpStatus: 409,
      repoId: repo.id,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      gate: "REINDEX_FAILED",
      message: `Reindex failed after stale index detection: ${msg}`,
      httpStatus: 500,
      repoId: repo.id,
    };
  }
}

/**
 * Classify a sync/diff failure into a stable gate. Callers use this when
 * refreshPrFiles / syncCloneForPr throws so empty diffs are never treated
 * as "no code changes."
 */
export function diffUnavailableResult(err: unknown, repoId?: string): ScanPreludeFail {
  const msg = err instanceof Error ? err.message : String(err);
  const isClone = /\bclone\b|\bsync\b|\bgit\b/i.test(msg);
  return {
    ok: false,
    gate: isClone ? "CLONE_FAILED" : "DIFF_UNAVAILABLE",
    message: isClone
      ? `Clone or sync failed — cannot build PR diff: ${msg}`
      : `Diff unavailable — cannot build authoritative file list: ${msg}`,
    httpStatus: 503,
    repoId,
  };
}

/**
 * Gates that must fail-fast on explicit review admit (`/dragnet` prcheck,
 * UI Run). Worker path still re-checks; explicit commands should not queue
 * work that is known to fail (e.g. missing LLM config).
 */
export function blocksExplicitAdmit(gate: ScanGateCode): boolean {
  return (
    gate === "CONFIG_REQUIRED" ||
    gate === "INDEX_REQUIRED" ||
    gate === "INDEXING_IN_PROGRESS" ||
    gate === "REINDEX_FAILED" ||
    gate === "CLONE_FAILED"
  );
}

/** Map prelude failure to the JSON body historically used by the scan route. */
export function preludeFailToJson(fail: ScanPreludeFail): Record<string, unknown> {
  if (fail.gate === "CONFIG_REQUIRED") {
    return {
      error: "SCAN_CONFIGURATION_REQUIRED",
      message: fail.message,
      issues: fail.issues ?? [],
      gate: fail.gate,
    };
  }
  return {
    error: fail.gate,
    message: fail.message,
    gate: fail.gate,
    ...(fail.repoId ? { repoId: fail.repoId } : {}),
  };
}
