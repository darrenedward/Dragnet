/**
 * Shared in-progress review tracker. Maps prId → start timestamp.
 *
 * Hoisted out of the command route so the in-app scan route
 * (`/api/prs/[prId]/scan`) shares the SAME lock — otherwise two concurrent
 * scans of one PR race `reviewFinding.deleteMany`→`createMany`,
 * double-increment `reviewsCount`, and write duplicate `reviewHistory`.
 * Both routes run in the same Node process, so this module singleton is
 * shared between them.
 *
 * Why TTL: a review that hangs (network partition, LLM stall, an unhandled
 * rejection that bypasses .catch) would otherwise sit in the Map forever,
 * blocking re-reviews. Entries older than REVIEW_TTL_MS are evicted on read
 * and the caller can re-queue.
 *
 * Restart note: in-memory only. A server crash mid-review loses the entry —
 * the PR simply appears "not in progress" and the caller can re-trigger.
 * Acceptable for single-user dev; a persistent queue is the production fix.
 */
import { assertNoActiveScan } from "./reviewFreshness";

const activeReviews = new Map<string, number>();
const REVIEW_TTL_MS = 5 * 60 * 1000;

export function isReviewActive(prId: string): boolean {
  const startedAt = activeReviews.get(prId);
  if (!startedAt) return false;
  if (Date.now() - startedAt > REVIEW_TTL_MS) {
    activeReviews.delete(prId);
    console.warn(`[review] lock timed out for ${prId} (>${REVIEW_TTL_MS}ms) — evicted`);
    return false;
  }
  return true;
}

/** Mark a PR's review as in-flight. */
export function beginReview(prId: string): void {
  activeReviews.set(prId, Date.now());
}

/** Clear a PR's in-flight marker (call in finally / .catch). */
export function endReview(prId: string): void {
  activeReviews.delete(prId);
}

/**
 * Atomic-feel acquisition of the review lock: in-memory check + DB-backed
 * active-scan check + beginReview, all from one call. All four scan entry
 * points (scan/route.ts, prcheck/route.ts, prepush/route.ts, command/route.ts)
 * MUST go through this helper — otherwise a UI scan and a concurrent CLI
 * prcheck on the same PR can both pass their respective guards and race
 * the persistence block.
 *
 * On success, caller MUST call `release()` in a finally block.
 * On failure, caller returns the 409 SCAN_IN_PROGRESS response.
 *
 * The residual race window between this check returning ok and
 * createReviewRun committing is microseconds; for a single-user dev tool
 * this is acceptable. The production-strength fix is a partial unique index
 * on ReviewRun(prId) WHERE status='in_progress' (catches duplicates via
 * Prisma P2002) — out of scope for this PR.
 */
export type ReviewLockResult =
  | { status: "acquired"; release: () => void }
  | { status: "busy"; runId: string; startedAt: Date; message: string };

export async function acquireReviewLock(
  prId: string,
  force: boolean,
): Promise<ReviewLockResult> {
  if (!force && isReviewActive(prId)) {
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
  beginReview(prId);
  return { status: "acquired", release: () => endReview(prId) };
}
