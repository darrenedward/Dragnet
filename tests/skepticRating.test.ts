import { describe, it, expect } from "vitest";
import { summarizeRejects } from "../src/lib/skepticRating";
import type { CandidateFinding } from "../src/services/findingVerifier/types";
import type { SkepticVerdict } from "../src/services/findingVerifier/skepticPass";

/**
 * Reject-summary tests (issue #72).
 *
 * `summarizeRejects` is the pure combiner used by `reviewService.ts`
 * after both the deterministic verifier and the skeptic pass have run.
 * It does not decide the rating — it just produces a picture of what
 * was rejected, what survived, and the `allRejected` / `anyRejected`
 * flags that the caller keys off to (a) null the rating or (b) trigger
 * the async LLM re-prompt in `skepticRerate.ts`.
 *
 * Contract under test:
 *  - Empty candidates → zeroed summary, no rejects
 *  - Nothing rejected → survivorCount = candidates.length, flags false
 *  - All rejected (verifier ∪ skeptic) → allRejected=true, survivorCount=0
 *  - Some rejected → anyRejected=true, allRejected=false
 *  - confirm/downgrade verdicts do NOT count as rejects
 *  - combinedRejectedIds = verifier ∪ skeptic reject id set
 */

function candidate(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Security",
    severity: "blocker",
    filename: "src/app.ts",
    line: 10,
    explanation: "bug",
    ...opts,
  };
}

function reject(): SkepticVerdict {
  return { verdict: "rejected", note: "fp" };
}

function confirm(): SkepticVerdict {
  return { verdict: "confirmed", note: "real" };
}

function downgrade(): SkepticVerdict {
  return { verdict: "downgraded", note: "lower", newSeverity: "warning" };
}

describe("summarizeRejects — empty / no-op cases", () => {
  it("returns a zeroed summary when candidate list is empty", () => {
    const result = summarizeRejects({
      candidates: [],
      verifierRejectedIds: new Set(),
      skepticMap: new Map(),
    });
    expect(result).toEqual({
      totalRejected: 0,
      skepticRejectedCount: 0,
      verifierRejectedCount: 0,
      survivorCount: 0,
      allRejected: false,
      anyRejected: false,
      combinedRejectedIds: new Set(),
    });
  });

  it("returns survivorCount = N and flags false when nothing is rejected", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([
        ["1", confirm()],
        ["2", confirm()],
      ]),
    });
    expect(result.totalRejected).toBe(0);
    expect(result.skepticRejectedCount).toBe(0);
    expect(result.verifierRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(2);
    expect(result.allRejected).toBe(false);
    expect(result.anyRejected).toBe(false);
    expect(result.combinedRejectedIds.size).toBe(0);
  });
});

describe("summarizeRejects — all rejected", () => {
  it("sets allRejected=true when skeptic rejects everything", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([
        ["1", reject()],
        ["2", reject()],
      ]),
    });
    expect(result.totalRejected).toBe(2);
    expect(result.skepticRejectedCount).toBe(2);
    expect(result.verifierRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(0);
    expect(result.allRejected).toBe(true);
    expect(result.anyRejected).toBe(true);
  });

  it("sets allRejected=true when verifier + skeptic together reject everything", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(["1"]),
      skepticMap: new Map([["2", reject()]]),
    });
    expect(result.totalRejected).toBe(2);
    expect(result.allRejected).toBe(true);
    expect(result.skepticRejectedCount).toBe(1);
    expect(result.verifierRejectedCount).toBe(1);
  });
});

describe("summarizeRejects — partial reject", () => {
  it("sets anyRejected=true, allRejected=false when only some are rejected", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "warning" }),
      candidate({ id: "3", severity: "suggestion" }),
    ];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    expect(result.totalRejected).toBe(1);
    expect(result.skepticRejectedCount).toBe(1);
    expect(result.verifierRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(2);
    expect(result.allRejected).toBe(false);
    expect(result.anyRejected).toBe(true);
  });

  it("counts verifier rejects toward the total and survivor deficit", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "blocker" }),
    ];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(["1"]),
      skepticMap: new Map(),
    });
    expect(result.totalRejected).toBe(1);
    expect(result.verifierRejectedCount).toBe(1);
    expect(result.skepticRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(1);
    expect(result.anyRejected).toBe(true);
  });
});

describe("summarizeRejects — ignores confirm/downgrade", () => {
  it("does not count downgrades or confirms as rejects", () => {
    const candidates = [candidate({ id: "1", severity: "blocker" })];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", downgrade()]]),
    });
    expect(result.totalRejected).toBe(0);
    expect(result.skepticRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(1);
    expect(result.allRejected).toBe(false);
    expect(result.anyRejected).toBe(false);
  });

  it("counts only the rejected verdicts in a mixed batch", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "blocker" }),
      candidate({ id: "3", severity: "blocker" }),
    ];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([
        ["1", confirm()],
        ["2", reject()],
        ["3", reject()],
      ]),
    });
    expect(result.skepticRejectedCount).toBe(2);
    expect(result.totalRejected).toBe(2);
    expect(result.survivorCount).toBe(1);
  });
});

describe("summarizeRejects — combinedRejectedIds", () => {
  it("builds the union of verifier + skeptic reject ids", () => {
    const candidates = [
      candidate({ id: "1" }),
      candidate({ id: "2" }),
      candidate({ id: "3" }),
      candidate({ id: "4" }),
    ];
    const result = summarizeRejects({
      candidates,
      verifierRejectedIds: new Set(["1", "2"]),
      skepticMap: new Map([
        ["2", reject()],
        ["3", reject()],
      ]),
    });
    // 2 is in both sets — union de-dupes it.
    expect(result.combinedRejectedIds).toEqual(new Set(["1", "2", "3"]));
    expect(result.totalRejected).toBe(3);
    expect(result.survivorCount).toBe(1);
  });
});
