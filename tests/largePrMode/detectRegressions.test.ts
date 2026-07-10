import { describe, expect, it } from "vitest";
import { detectRegressions } from "../../src/services/largePrReview/reconcile";

describe("detectRegressions", () => {
  it("flags a regression when a resolved finding reappears with changed sourceHash", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-changed" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-1" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toEqual({
      currentFindingId: "new-1",
      priorFindingId: "resolved-1",
      regressedFromRunId: "run-1",
    });
  });

  it("does NOT flag regression when sourceHash is unchanged (false positive recovery)", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-same" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-same", resolvedAtRunId: "run-1" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(0);
  });

  it("does NOT flag regression for genuinely new findings (no prior on fingerprint)", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-new", sourceHashAtInsert: "hash-new" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-other", sourceHashAtInsert: "hash-other", resolvedAtRunId: "run-1" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(0);
  });

  it("handles multiple findings correctly (mixed regression, non-regression, and new)", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-regression", sourceHashAtInsert: "hash-changed" },
      { id: "new-2", fingerprint: "fp-no-regression", sourceHashAtInsert: "hash-same" },
      { id: "new-3", fingerprint: "fp-new", sourceHashAtInsert: "hash-new" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-regression", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-1" },
      { id: "resolved-2", fingerprint: "fp-no-regression", sourceHashAtInsert: "hash-same", resolvedAtRunId: "run-2" },
      { id: "resolved-3", fingerprint: "fp-unmatched", sourceHashAtInsert: "hash-unmatched", resolvedAtRunId: "run-3" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(1);
    expect(regressions[0].currentFindingId).toBe("new-1");
    expect(regressions[0].priorFindingId).toBe("resolved-1");
  });

  it("defense-in-depth: one current finding cannot match two priors", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-changed" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-1" },
      { id: "resolved-2", fingerprint: "fp-x", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-2" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    // Should only match one prior (first match wins)
    expect(regressions).toHaveLength(1);
  });

  it("returns empty array when no findings provided", () => {
    const regressions = detectRegressions([], []);
    expect(regressions).toHaveLength(0);
  });

  it("handles null fingerprints gracefully", () => {
    const currentFindings = [
      { id: "new-1", fingerprint: null, sourceHashAtInsert: "hash-changed" },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-1" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(0);
  });

  it("handles null sourceHashAtInsert gracefully (treats as regression)", () => {
    // If sourceHashAtInsert is null on either side, we can't verify code changed
    // Conservative approach: treat as potential regression
    const currentFindings = [
      { id: "new-1", fingerprint: "fp-x", sourceHashAtInsert: null },
    ];
    const resolvedFindings = [
      { id: "resolved-1", fingerprint: "fp-x", sourceHashAtInsert: "hash-original", resolvedAtRunId: "run-1" },
    ];

    const regressions = detectRegressions(currentFindings, resolvedFindings);

    expect(regressions).toHaveLength(1);
  });
});
