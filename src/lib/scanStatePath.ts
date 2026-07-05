/**
 * Scan state path utility — resolves the centralised on-disk location for
 * per-repo scan artifacts (checkpoints, reports, provider health, reviews).
 *
 * Slice 2 of the scan-state centralisation spec. Replaces the old per-repo
 * `<repo.path>/.dragnet/` layout with a deterministic path under a
 * configurable root directory.
 *
 * **Default root:** `/var/lib/dragnet/scans`
 * **Env override:** `DRAGNET_SCAN_STATE_ROOT`
 *
 * **Layout within root:** `<root>/<repoId>/`
 *   - `<root>/<repoId>/checkpoints/<runId>/<checkpointId>.json`
 *   - `<root>/<repoId>/reports/<runId>.md`
 *   - `<root>/<repoId>/provider-health.json`
 *   - `<root>/<repoId>/reviews/<prSlug>/<runId>.md`
 *
 * **Back-compat:** each subsystem in checkpointStore.ts, reportLogger.ts,
 * and providerHealth.ts accepts an optional `repoId` parameter. When
 * omitted, the legacy `<repoPath>/.dragnet/` path is used so repos that
 * haven't run the migration script still work.
 *
 * **Migration:** `scripts/migrate-scan-state.mjs` moves existing state
 * from per-repo `.dragnet/` dirs into the centralised path.
 */

/**
 * Default root for scan state. Intentionally a filesystem path outside
 * the app directory so Docker volumes and backups target a single tree.
 */
export const DEFAULT_SCAN_STATE_ROOT = "/var/lib/dragnet/scans";

/**
 * Returns the scan state root directory. Reads `DRAGNET_SCAN_STATE_ROOT`
 * env var; falls back to `DEFAULT_SCAN_STATE_ROOT` when unset.
 */
export function getScanStateRoot(): string {
  return process.env.DRAGNET_SCAN_STATE_ROOT ?? DEFAULT_SCAN_STATE_ROOT;
}

/**
 * Returns the per-repo scan state directory.
 * `<root>/<repoId>/`
 *
 * Does NOT create the directory — callers are responsible for mkdir.
 */
export function getScanStatePath(repoId: string): string {
  const root = getScanStateRoot();
  return `${root}/${repoId}`;
}

/**
 * Helper for callers that need a subdirectory within the scan state path.
 * Returns `<root>/<repoId>/<subdir>`.
 */
export function getScanStateSubdir(repoId: string, subdir: string): string {
  return `${getScanStatePath(repoId)}/${subdir}`;
}

/**
 * Returns the legacy per-repo path `<repoPath>/.dragnet/`.
 * Used as a fallback when `repoId` is not available (unmigrated repos).
 */
export function getLegacyScanStatePath(repoPath: string): string {
  return `${repoPath}/.dragnet`;
}
