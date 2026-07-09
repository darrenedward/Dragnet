/**
 * Cross-scan skeptic pass accumulator (issue #73).
 *
 * Tracks per-`{provider_host}:{model}` outcome counts so the UI can
 * surface an "agreeable skeptic" warning when a fallback model rubber-
 * stamps findings (reject rate <2% over >=50 adjudicated findings).
 *
 * **Persistence:** same layout as `providerHealth.ts`:
 *   `<scanStateRoot>/<repoId>/skeptic-stats.json` (centralised)
 *   `<repoPath>/.dragnet/skeptic-stats.json` (legacy)
 *
 * **Concurrency:** read-modify-write is approximate under concurrent
 * scans. Off-by-one under contention is acceptable — the warning
 * threshold is heuristic, and the app already prevents same-PR
 * concurrent scans.
 *
 * **Warning threshold:** the panel declares a skeptic "agreeable" when
 * rejectRate() < `WARN_REJECT_RATE` AND adjudicated total >= `WARN_MIN_ADJUDICATED`.
 * Defaults: 2% over >=50 findings (per issue #73 spec).
 */

import fs from "node:fs";
import path from "node:path";
import { getScanStatePath, getLegacyScanStatePath } from "@/src/lib/scanStatePath";

/**
 * Per-provider cumulative outcome counts. Only `confirmed + downgraded +
 * rejected` count toward `adjudicated` — failures (skipped, error) don't
 * belong in the denominator because the model never graded them.
 */
export interface ProviderSkepticStats {
  confirmed: number;
  downgraded: number;
  rejected: number;
  /** Epoch ms of last update (debugging). */
  updatedAt: number;
  /** Display-only preset name; not part of the key. */
  presetName?: string;
}

export interface SkepticStatsFile {
  /** Key: `{provider_host}:{model}`. */
  providers: Record<string, ProviderSkepticStats>;
}

/** Reject rate above which a skeptic is "healthy" (rejecting some). */
export const WARN_REJECT_RATE = 0.02;

/** Minimum adjudicated findings before the warning can fire. Avoids
 *  noisy warnings on small sample sizes (1 of 10 = 10% looks fine but
 *  tells you nothing). */
export const WARN_MIN_ADJUDICATED = 50;

export function emptyStats(): ProviderSkepticStats {
  return { confirmed: 0, downgraded: 0, rejected: 0, updatedAt: 0 };
}

/**
 * Total findings the model actually graded. Failed/skipped findings
 * never count toward the denominator — the warning is "this model
 * confirms everything it sees", not "this model had a network glitch".
 */
export function adjudicatedTotal(s: ProviderSkepticStats | undefined): number {
  if (!s) return 0;
  return s.confirmed + s.downgraded + s.rejected;
}

/**
 * Reject rate as a fraction in [0, 1]. 0 when nothing has been
 * adjudicated. Higher = more adversarial.
 */
export function rejectRate(s: ProviderSkepticStats | undefined): number {
  const total = adjudicatedTotal(s);
  if (total === 0) return 0;
  return s!.rejected / total;
}

/**
 * Should the panel show the agreeable-skeptic warning for this provider?
 * True iff the model has adjudicated enough findings AND rejects almost
 * none of them.
 */
export function isAgreeableSkeptic(s: ProviderSkepticStats | undefined): boolean {
  if (!s) return false;
  const total = adjudicatedTotal(s);
  if (total < WARN_MIN_ADJUDICATED) return false;
  return rejectRate(s) < WARN_REJECT_RATE;
}

/**
 * Read the stats file. Returns an empty record set on missing file or
 * corrupt JSON — caller cannot recover from a malformed file, and we
 * must not block scans on one. Logged at warn (never thrown).
 */
export function readStatsFile(repoPath: string, repoId?: string): SkepticStatsFile {
  const filePath = statsFilePath(repoPath, repoId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.providers) {
      return { providers: parsed.providers as Record<string, ProviderSkepticStats> };
    }
    return { providers: {} };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[skepticStats] failed to read ${filePath}: ${err?.message ?? err}`);
    }
    return { providers: {} };
  }
}

/**
 * Atomic write: mkdir -p, write to `<file>.tmp` at mode 0600, rename.
 * Failures are logged and swallowed — a failed stats write must not
 * fail the scan.
 */
export function writeStatsFile(repoPath: string, file: SkepticStatsFile, repoId?: string): void {
  const filePath = statsFilePath(repoPath, repoId);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err: any) {
    console.warn(`[skepticStats] failed to write ${filePath}: ${err?.message ?? err}`);
  }
}

/**
 * Resolve the stats file path. When `repoId` is provided, uses the
 * central scan-state path; otherwise falls back to the legacy path.
 */
export function statsFilePath(repoPath: string, repoId?: string): string {
  return repoId
    ? path.join(getScanStatePath(repoId), "skeptic-stats.json")
    : path.join(getLegacyScanStatePath(repoPath), "skeptic-stats.json");
}

/**
 * Record outcome counts for `{providerKey}` to disk. Reads, mutates,
 * writes. Approximate under concurrent scans — acceptable per spec.
 *
 * No-ops and logs when both `repoPath` and `repoId` are missing. The
 * Dragnet server's cwd is its install dir, not the scanned repo; never
 * fall back to `process.cwd()` — that would write stats into the wrong
 * project.
 */
export function recordSkepticOutcomes(
  repoPath: string | null | undefined,
  providerKey: string,
  delta: { confirmed: number; downgraded: number; rejected: number },
  repoId?: string,
  presetName?: string,
): void {
  if (!repoPath && !repoId) {
    console.warn("[skepticStats] recordOutcomes skipped: no repoPath or repoId");
    return;
  }
  if (!providerKey) return;
  const now = Date.now();
  const file = readStatsFile(repoPath ?? "", repoId);
  const prev = file.providers[providerKey] ?? emptyStats();
  const next: ProviderSkepticStats = {
    confirmed: prev.confirmed + (delta.confirmed ?? 0),
    downgraded: prev.downgraded + (delta.downgraded ?? 0),
    rejected: prev.rejected + (delta.rejected ?? 0),
    updatedAt: now,
  };
  if (presetName) next.presetName = presetName;
  file.providers[providerKey] = next;
  writeStatsFile(repoPath ?? "", file, repoId);
}

/**
 * Return stats for one provider key. undefined when no record exists.
 */
export function getProviderStats(
  repoPath: string | null | undefined,
  providerKey: string,
  repoId?: string,
): ProviderSkepticStats | undefined {
  if (!repoPath && !repoId) return undefined;
  if (!providerKey) return undefined;
  const file = readStatsFile(repoPath ?? "", repoId);
  return file.providers[providerKey];
}

/**
 * Snapshot every provider's stats. Used by the SkepticPanel to render
 * the current fallback's reject rate.
 */
export function listProviderStats(
  repoPath: string | null | undefined,
  repoId?: string,
): SkepticStatsFile {
  if (!repoPath && !repoId) return { providers: {} };
  return readStatsFile(repoPath ?? "", repoId);
}

/**
 * Reset stats. With no providerKey: clears the entire file. With one:
 * deletes just that key.
 */
export function resetProviderStats(
  repoPath: string | null | undefined,
  providerKey?: string,
  repoId?: string,
): void {
  if (!repoPath && !repoId) return;
  if (!providerKey) {
    writeStatsFile(repoPath ?? "", { providers: {} }, repoId);
    return;
  }
  const file = readStatsFile(repoPath ?? "", repoId);
  delete file.providers[providerKey];
  writeStatsFile(repoPath ?? "", file, repoId);
}
