import { prisma } from "../lib/prisma";
import { SCAN_STALE_AFTER_MS } from "../lib/reviewFreshness";

/**
 * Stale-run reaper.
 *
 * Why this exists: when the dev serverless instance / Next worker / dev
 * laptop is killed mid-scan (ctrl-c, crash, OOM, deploy eviction), the
 * in-memory review lock evaporates but the `ReviewRun` row stays
 * `in_progress` forever. Future scans on that PR trip the
 * `assertNoActiveScan` guard and 409 — the PR is bricked until someone
 * manually updates the DB or passes `?force=true`.
 *
 * Two layers of defense:
 *
 *   1. `src/lib/reviewFreshness.ts:assertNoActiveScan` reaps on-demand
 *      when a new scan would trip on an orphan. Lazy — runs only when
 *      the PR is hit again.
 *
 *   2. This function (Layer 3): eager sweep at boot. Catches orphans
 *      before the first request even hits the guard, so a freshly
 *      restarted server presents a clean state to the operator.
 *
 * Idempotent: safe to call multiple times. `updateMany` is a single
 * atomic SQL UPDATE; concurrent reapers (rare — only happens if boot
 * overlaps with a Layer 2 reap) won't double-count.
 *
 * Failure mode: never throws. DB unavailable at boot → log + move on.
 * The scan guard (Layer 2) will retry on the next request.
 */
export async function reapStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - SCAN_STALE_AFTER_MS);
  try {
    const result = await prisma.reviewRun.updateMany({
      where: {
        status: "in_progress",
        OR: [
          { lastActivityAt: { lt: cutoff } },
          { lastActivityAt: null, lastCheckpointAt: { lt: cutoff } },
          { lastActivityAt: null, lastCheckpointAt: null, startedAt: { lt: cutoff } },
        ],
      },
      data: {
        status: "failed",
        completedAt: new Date(),
        reliability: "partial",
        terminalClass: "infrastructure_failure",
        systemWarn: "Orphaned in_progress run reaped after losing its activity heartbeat.",
      },
    });
    if (result.count > 0) {
      console.warn(
        `[runReaper] cold-start sweep reaped ${result.count} orphaned ` +
          `in_progress run(s) older than ${Math.round(SCAN_STALE_AFTER_MS / 60_000)}min. ` +
          `Likely cause: prior process was killed/crashed mid-scan.`,
      );
    }
    return result.count;
  } catch (err) {
    // Don't crash boot. Layer 2 will retry on the next request that hits
    // the affected PRs.
    console.error(
      "[runReaper] cold-start sweep failed (DB unavailable?):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}
