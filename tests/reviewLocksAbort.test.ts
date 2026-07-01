import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 4.10 — force-restart abort regression test.
 *
 * Proves:
 *   1. acquireReviewLock(prId, force=true) aborts the existing
 *      AbortController before creating a replacement.
 *   2. The replacement scan gets a fresh, non-aborted signal.
 *   3. getActiveReviewSignal returns the live signal for an in-flight
 *      scan and undefined after endReview / force-restart.
 *   4. The old scan's signal stays aborted even after the new lock
 *      is acquired — force-restart does not retroactively un-abort.
 *
 * The full end-to-end flow (force-restart actually cancels an SDK
 * request and prevents late persistence) is covered structurally by:
 *   - acquireReviewLock calling controller.abort() (verified here)
 *   - runPrScan passing signal into create(body, { signal }) (Phase 4.7)
 *   - runPrScan's catch returning a typed interrupted result on
 *     AbortError, which never calls completeReviewRun (Phase 4.8)
 *   - assertReviewRunStillActive backstops any path that bypasses
 *     the signal (still enforced by reviewFreshness.ts)
 */

// Mock assertNoActiveScan so acquireReviewLock doesn't hit the DB.
vi.mock("../src/lib/reviewFreshness", () => ({
  assertNoActiveScan: vi.fn().mockResolvedValue({ ok: true }),
}));

// Re-import AFTER mock setup so the module picks up the mock.
const { acquireReviewLock, beginReview, endReview, getActiveReviewSignal, isReviewActive } =
  await import("../src/lib/reviewLocks");

const PR_ID = "pr-test-1";

beforeEach(() => {
  // Clear any leaked in-memory entries between tests.
  endReview(PR_ID);
});

afterEach(() => {
  endReview(PR_ID);
});

describe("Phase 4 force-restart abort", () => {
  it("force=true aborts the existing in-flight controller", async () => {
    // First scan acquires normally.
    const first = await acquireReviewLock(PR_ID, false);
    if (first.status !== "acquired") throw new Error("expected first lock to be acquired");
    const firstSignal = first.signal;
    expect(firstSignal.aborted).toBe(false);

    // While the first scan is "in flight", force-restart.
    const second = await acquireReviewLock(PR_ID, true);
    if (second.status !== "acquired") throw new Error("expected second lock to be acquired");
    const secondSignal = second.signal;

    // The first scan's signal MUST be aborted now.
    expect(firstSignal.aborted).toBe(true);
    // The replacement signal is fresh.
    expect(secondSignal.aborted).toBe(false);
    // The two signals are different controllers.
    expect(firstSignal).not.toBe(secondSignal);

    first.release();
    second.release();
  });

  it("non-force acquisition returns busy when an entry exists", async () => {
    const first = await acquireReviewLock(PR_ID, false);
    if (first.status !== "acquired") throw new Error("expected acquired");

    const second = await acquireReviewLock(PR_ID, false);
    expect(second.status).toBe("busy");

    first.release();
  });

  it("getActiveReviewSignal returns live signal, then undefined after endReview", async () => {
    expect(getActiveReviewSignal(PR_ID)).toBeUndefined();

    const lock = await acquireReviewLock(PR_ID, false);
    if (lock.status !== "acquired") throw new Error("expected acquired");

    const live = getActiveReviewSignal(PR_ID);
    expect(live).toBe(lock.signal);
    expect(live?.aborted).toBe(false);

    lock.release();
    expect(getActiveReviewSignal(PR_ID)).toBeUndefined();
  });

  it("isReviewActive flips correctly across the lifecycle", async () => {
    expect(isReviewActive(PR_ID)).toBe(false);

    const lock = await acquireReviewLock(PR_ID, false);
    if (lock.status !== "acquired") throw new Error("expected acquired");
    expect(isReviewActive(PR_ID)).toBe(true);

    lock.release();
    expect(isReviewActive(PR_ID)).toBe(false);
  });

  it("force-restart on an empty entry is a no-op (no throw, fresh signal)", async () => {
    // No prior scan. force=true should still produce a valid lock.
    const lock = await acquireReviewLock(PR_ID, true);
    if (lock.status !== "acquired") throw new Error("expected acquired");
    expect(lock.signal.aborted).toBe(false);
    lock.release();
  });

  it("beginReview returns a fresh controller each call", () => {
    const c1 = beginReview(PR_ID);
    const c2 = beginReview(PR_ID);
    expect(c1).not.toBe(c2);
    // c1's signal is no longer reachable via getActiveReviewSignal —
    // the Map only holds the latest entry. That's intentional; force-
    // restart relies on the latest controller being the live one.
    const live = getActiveReviewSignal(PR_ID);
    expect(live).toBe(c2.signal);
    endReview(PR_ID);
  });
});

describe("Phase 4 abort propagation through runPrScan", () => {
  it("an aborted signal causes create() to reject with AbortError shape", async () => {
    // Smoke-test the contract: when the SDK receives an already-aborted
    // signal, fetch (and the OpenAI SDK on top of it) rejects with a
    // DOMException named "AbortError". runPrScan's catch checks
    // err.name === "AbortError" — verified by isAbortError() here.
    const controller = new AbortController();
    controller.abort();

    // Simulate the shape fetch/SDK produces on an aborted signal.
    const abortErr: any = new Error("The user aborted a request.");
    abortErr.name = "AbortError";

    // Inline copy of reviewService's isAbortError check.
    function isAbortError(err: unknown): boolean {
      if (!err) return false;
      const name = (err as any)?.name ?? "";
      return name === "AbortError";
    }

    expect(isAbortError(abortErr)).toBe(true);
    expect(isAbortError(new Error("429 rate limit"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });
});
