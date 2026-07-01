/**
 * Shared in-progress review tracker. Maps prId → { startedAt, controller }.
 *
 * Hoisted out of the command route so the in-app scan route
 * (`/api/prs/[prId]/scan`) shares the SAME lock — otherwise two concurrent
 * scans of one PR race `reviewFinding.deleteMany`→`createMany`,
 * double-increment `reviewsCount`, and write duplicate `reviewHistory`.
 * Both routes run in the same Node process, so this module singleton is
 * shared between them.
 *
 * **Phase 4 AbortController:** each active entry now carries an
 * `AbortController` whose signal is threaded into the scan runner and
 * the LLM SDK calls. `force=true` calls `controller.abort()` on the
 * existing entry so the in-flight scan stops burning tokens and
 * returns a typed interrupted result, instead of racing the
 * replacement scan's persistence block.
 *
 * Why TTL: a review that hangs (network partition, LLM stall, an unhandled
 * rejection that bypasses .catch) would otherwise sit in the Map forever,
 * blocking re-reviews. Entries older than REVIEW_TTL_MS are evicted on
 * read and the caller can re-queue.
 *
 * Restart note: in-memory only. A server crash mid-review loses the entry —
 * the PR simply appears "not in progress" and the caller can re-trigger.
 * Acceptable for single-user dev; a persistent queue is the production fix.
 */
import { assertNoActiveScan } from "./reviewFreshness";

// Active reviews tracked in-memory. Module-level state — survives hot
// reloads in dev unless this file is edited. To force-clear (e.g. after
// a successful scan that leaked the lock), edit this comment + save.
//
// Phase 4: value shape is { startedAt, controller } so force-restart
// can abort the in-flight scan.
const activeReviews = new Map<string, { startedAt: number; controller: AbortController }>();
// MUST stay aligned with SCAN_STALE_AFTER_MS in reviewFreshness.ts. Both
// layers must agree on when an orphaned scan is stale — if the in-memory
// TTL is longer than the DB stale threshold, a hot-reloaded scan leaves
// an entry that blocks new scans via 409 SCAN_IN_PROGRESS long after the
// DB row has been reaped. acquireReviewLock checks this Map BEFORE the
// DB, so a stale entry here is authoritative until it expires.
//
// 5 min (was 30): aligned with the DB threshold after commit 852ea5b
// lowered SCAN_STALE_AFTER_MS to 5 min for faster dev-server-restart
// recovery. The duplicate-scan risk on legitimate >5 min chunked scans
// is the same at both layers — fixable downstream with a partial unique
// index on ReviewRun(prId) WHERE status='in_progress' (P2006) or a
// heartbeat, not by re-divorcing these two constants.
const REVIEW_TTL_MS = 5 * 60 * 1000;

export function isReviewActive(prId: string): boolean {
  const entry = activeReviews.get(prId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > REVIEW_TTL_MS) {
    activeReviews.delete(prId);
    console.warn(`[review] lock timed out for ${prId} (>${REVIEW_TTL_MS}ms) — evicted`);
    return false;
  }
  return true;
}

/**
 * Mark a PR's review as in-flight. Returns the new AbortController so
 * the caller (acquireReviewLock) can hand its signal to the scan runner.
 * The controller is owned by this Map — callers should NOT call abort()
 * on it directly; force-restart goes through acquireReviewLock.
 */
export function beginReview(prId: string): AbortController {
  const controller = new AbortController();
  activeReviews.set(prId, { startedAt: Date.now(), controller });
  return controller;
}

/** Clear a PR's in-flight marker (call in finally / .catch). */
export function endReview(prId: string): void {
  activeReviews.delete(prId);
}

/**
 * Returns the live AbortSignal for an in-flight scan, or undefined when
 * no scan is active. The signal is the same one passed into runPrScan
 * by acquireReviewLock. Test/mocking code uses this to verify the
 * controller wiring without going through HTTP.
 */
export function getActiveReviewSignal(prId: string): AbortSignal | undefined {
  const entry = activeReviews.get(prId);
  if (!entry) return undefined;
  if (Date.now() - entry.startedAt > REVIEW_TTL_MS) {
    activeReviews.delete(prId);
    return undefined;
  }
  return entry.controller.signal;
}

/**
 * Atomic-feel acquisition of the review lock: in-memory check + DB-backed
 * active-scan check + beginReview, all from one call. All four scan entry
 * points (scan/route.ts, prcheck/route.ts, prepush/route.ts, command/route.ts)
 * MUST go through this helper — otherwise a UI scan and a concurrent CLI
 * prcheck on the same PR can both pass their respective guards and race
 * the persistence block.
 *
 * **Phase 4 force-restart:** when `force=true` is set AND an in-memory
 * entry exists, the existing controller is aborted before the new entry
 * is created. The in-flight scan sees an AbortError, returns a typed
 * interrupted result, and stops calling SDK functions / writing to the
 * old run row. The replacement scan gets a fresh controller + signal.
 *
 * On success, caller MUST call `release()` in a finally block and pass
 * `signal` into the scan runner.
 * On failure, caller returns the 409 SCAN_IN_PROGRESS response.
 *
 * The residual race window between this check returning ok and
 * createReviewRun committing is microseconds; for a single-user dev tool
 * this is acceptable. The production-strength fix is a partial unique index
 * on ReviewRun(prId) WHERE status='in_progress' (catches duplicates via
 * Prisma P2002) — out of scope for this PR.
 */
export type ReviewLockResult =
  | { status: "acquired"; release: () => void; signal: AbortSignal }
  | { status: "busy"; runId: string; startedAt: Date; message: string };

export async function acquireReviewLock(
  prId: string,
  force: boolean,
): Promise<ReviewLockResult> {
  if (force) {
    // Abort the in-flight scan BEFORE the DB check, so the old scan's
    // next assertion / SDK call rejects before we create the replacement
    // run row. Without this, the old scan could complete a tool call
    // and call setReviewRunTokens between our acquireReviewLock call
    // and the abort actually firing.
    const existing = activeReviews.get(prId);
    if (existing) {
      console.log(`[review] force=true — aborting in-flight scan for ${prId}`);
      try {
        existing.controller.abort();
      } catch (err: any) {
        console.warn(`[review] abort() threw for ${prId}: ${err?.message ?? err}`);
      }
      // Remove the old entry immediately. The old scan's finally block
      // will call endReview() too — that's a no-op once we've deleted.
      activeReviews.delete(prId);
    }
  } else if (isReviewActive(prId)) {
    return {
      status: "busy",
      runId: "(in-memory)",
      startedAt: new Date(),
      message: "A review is already in progress for this PR (in-memory lock).",
    };
  }
  const dbCheck = await assertNoActiveScan(prId, force);
  if (dbCheck.ok === false) {
    return {
      status: "busy",
      runId: dbCheck.runId,
      startedAt: dbCheck.startedAt,
      message: `Scan already running (started ${dbCheck.startedAt.toISOString()}).`,
    };
  }
  const controller = beginReview(prId);
  return {
    status: "acquired",
    release: () => endReview(prId),
    signal: controller.signal,
  };
}
