import { describe, it, expect } from "vitest";
import { recomputeRatingAfterSkeptic } from "../src/lib/skepticRating";
import type { CandidateFinding } from "../src/services/findingVerifier/types";
import type { SkepticVerdict } from "../src/services/findingVerifier/skepticPass";

/**
 * Rating recomputation tests (issue #72).
 *
 * The helper extends the existing "null rating when every finding is
 * rejected" check to also count skeptic rejects, and adds a partial-reject
 * path that bumps the rating up by a severity-weighted amount per rejected
 * finding (false positives dragged the LLM's score down).
 *
 * Contract under test:
 *  - All candidates rejected (verifier + skeptic combined) → null, allRejected=true
 *  - Some rejected → rating bumped, adjusted=true, allRejected=false
 *  - None rejected → original rating, adjusted=false
 *  - Empty candidates → original rating, no change
 *  - Original rating null + some rejects → still null (can't bump null)
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

describe("recomputeRatingAfterSkeptic — empty / no-op cases", () => {
  it("returns original rating when candidate list is empty", () => {
    const result = recomputeRatingAfterSkeptic({
      originalRating: 7,
      candidates: [],
      verifierRejectedIds: new Set(),
      skepticMap: new Map(),
    });
    expect(result).toEqual({
      rating: 7,
      adjusted: false,
      allRejected: false,
      skepticRejectedCount: 0,
      verifierRejectedCount: 0,
      survivorCount: 0,
    });
  });

  it("returns original rating when nothing is rejected", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 6,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", confirm()], ["2", confirm()]]),
    });
    expect(result.rating).toBe(6);
    expect(result.adjusted).toBe(false);
    expect(result.allRejected).toBe(false);
    expect(result.survivorCount).toBe(2);
  });
});

describe("recomputeRatingAfterSkeptic — all rejected → null", () => {
  it("nulls rating when skeptic rejects everything", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 5,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()], ["2", reject()]]),
    });
    expect(result.rating).toBe(null);
    expect(result.adjusted).toBe(true);
    expect(result.allRejected).toBe(true);
    expect(result.skepticRejectedCount).toBe(2);
    expect(result.verifierRejectedCount).toBe(0);
    expect(result.survivorCount).toBe(0);
  });

  it("nulls rating when verifier + skeptic together reject everything", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 5,
      candidates,
      verifierRejectedIds: new Set(["1"]),
      skepticMap: new Map([["2", reject()]]),
    });
    expect(result.rating).toBe(null);
    expect(result.allRejected).toBe(true);
    expect(result.skepticRejectedCount).toBe(1);
    expect(result.verifierRejectedCount).toBe(1);
  });

  it("preserves allRejected=true when rating was already null", () => {
    // Important: the scan engine keys the systemWarn off allRejected, not
    // adjusted. A null rating that stays null still needs the banner.
    const candidates = [candidate({ id: "1" })];
    const result = recomputeRatingAfterSkeptic({
      originalRating: null,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    expect(result.rating).toBe(null);
    expect(result.adjusted).toBe(false);
    expect(result.allRejected).toBe(true);
  });
});

describe("recomputeRatingAfterSkeptic — partial reject → bump", () => {
  it("bumps rating by 1.0 per rejected blocker", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "blocker" }),
      candidate({ id: "3", severity: "blocker" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 5,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    // 5 + 1.0 = 6.0 → round → 6
    expect(result.rating).toBe(6);
    expect(result.adjusted).toBe(true);
    expect(result.allRejected).toBe(false);
    expect(result.skepticRejectedCount).toBe(1);
    expect(result.survivorCount).toBe(2);
  });

  it("bumps rating by 0.5 per rejected warning", () => {
    const candidates = [
      candidate({ id: "1", severity: "warning" }),
      candidate({ id: "2", severity: "warning" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 6,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    // 6 + 0.5 = 6.5 → round → 7 (Math.round rounds half up)
    expect(result.rating).toBe(7);
  });

  it("bumps rating by 0.25 per rejected suggestion", () => {
    const candidates = [
      candidate({ id: "1", severity: "suggestion" }),
      candidate({ id: "2", severity: "suggestion" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 7,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    // 7 + 0.25 = 7.25 → round → 7
    expect(result.rating).toBe(7);
    expect(result.adjusted).toBe(false);
  });

  it("accumulates bumps across multiple rejected findings of mixed severity", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "warning" }),
      candidate({ id: "3", severity: "suggestion" }),
      candidate({ id: "4", severity: "blocker" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 4,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([
        ["1", reject()],
        ["2", reject()],
        ["3", reject()],
      ]),
    });
    // 4 + 1.0 (blocker) + 0.5 (warning) + 0.25 (suggestion) = 5.75 → round → 6
    expect(result.rating).toBe(6);
    expect(result.survivorCount).toBe(1);
  });

  it("clamps the bumped rating to 10", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate({ id: String(i), severity: "blocker" }),
    );
    const skepticMap = new Map<string, SkepticVerdict>();
    for (let i = 0; i < 10; i++) {
      skepticMap.set(String(i), reject());
    }
    // Wait — all 10 rejected means survivorCount=0 → null. Adjust to 9 rejects.
    skepticMap.delete("9");
    const result = recomputeRatingAfterSkeptic({
      originalRating: 8,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap,
    });
    // 8 + 9 * 1.0 = 17 → clamp to 10
    expect(result.rating).toBe(10);
    expect(result.adjusted).toBe(true);
    expect(result.allRejected).toBe(false);
    expect(result.survivorCount).toBe(1);
  });

  it("counts verifier rejects toward the bump too", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "blocker" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 5,
      candidates,
      verifierRejectedIds: new Set(["1"]),
      skepticMap: new Map(),
    });
    // 5 + 1.0 = 6
    expect(result.rating).toBe(6);
    expect(result.skepticRejectedCount).toBe(0);
    expect(result.verifierRejectedCount).toBe(1);
  });
});

describe("recomputeRatingAfterSkeptic — original rating null", () => {
  it("returns null with no adjustment when original is null and not all rejected", () => {
    const candidates = [candidate({ id: "1" }), candidate({ id: "2" })];
    const result = recomputeRatingAfterSkeptic({
      originalRating: null,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", reject()]]),
    });
    expect(result.rating).toBe(null);
    expect(result.adjusted).toBe(false);
    expect(result.allRejected).toBe(false);
    // Should still report counts for observability.
    expect(result.skepticRejectedCount).toBe(1);
    expect(result.survivorCount).toBe(1);
  });
});

describe("recomputeRatingAfterSkeptic — ignores skeptic confirms/downgrades", () => {
  it("does not bump when skeptic only confirms or downgrades", () => {
    const candidates = [candidate({ id: "1", severity: "blocker" })];
    const downgrade: SkepticVerdict = {
      verdict: "downgraded",
      note: "lower",
      newSeverity: "warning",
    };
    const result = recomputeRatingAfterSkeptic({
      originalRating: 6,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([["1", downgrade]]),
    });
    // Downgrade is a severity mutation, not a false-positive reject. The
    // rating bump only applies to verdicts that remove a finding.
    expect(result.rating).toBe(6);
    expect(result.adjusted).toBe(false);
    expect(result.skepticRejectedCount).toBe(0);
  });

  it("counts only the rejected verdicts in a mixed batch", () => {
    const candidates = [
      candidate({ id: "1", severity: "blocker" }),
      candidate({ id: "2", severity: "blocker" }),
      candidate({ id: "3", severity: "blocker" }),
    ];
    const result = recomputeRatingAfterSkeptic({
      originalRating: 5,
      candidates,
      verifierRejectedIds: new Set(),
      skepticMap: new Map([
        ["1", confirm()],
        ["2", reject()],
        ["3", reject()],
      ]),
    });
    // 5 + 2 * 1.0 = 7
    expect(result.rating).toBe(7);
    expect(result.skepticRejectedCount).toBe(2);
    expect(result.survivorCount).toBe(1);
  });
});
