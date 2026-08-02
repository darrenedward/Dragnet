import { describe, expect, it } from "vitest";
import {
  clusterDuplicateIds,
  planRootCauseClusters,
  rootCauseKey,
  type ClusterFinding,
} from "../../src/services/largePrReview/cluster";

function f(partial: Partial<ClusterFinding> & Pick<ClusterFinding, "id">): ClusterFinding {
  return {
    fingerprint: partial.fingerprint ?? `fp-${partial.id}`,
    category: partial.category ?? "Correctness",
    severity: partial.severity ?? "warning",
    filename: partial.filename ?? "a.ts",
    line: partial.line ?? 10,
    explanation:
      partial.explanation ??
      "Null check missing before dereference of user profile object",
    confidence: partial.confidence ?? 0.9,
    evidenceChain: partial.evidenceChain ?? null,
    ...partial,
  };
}

describe("rootCauseKey", () => {
  it("strips paths and line numbers so cross-chunk wording collapses", () => {
    const a = rootCauseKey("Null check missing in src/foo.ts:42 before dereference of user");
    const b = rootCauseKey("Null check missing in src/bar.ts line 99 before dereference of user");
    expect(a).toBe(b);
    expect(a).toContain("null check missing");
    expect(a).not.toContain("foo");
    expect(a).not.toContain("bar");
  });
});

describe("planRootCauseClusters", () => {
  it("merges high-confidence crossover pairs into one multi-location group", () => {
    const stem =
      "Missing authorization check on admin endpoint before mutating protected resources";
    const findings = [
      f({
        id: "f1",
        filename: "auth/session.ts",
        line: 40,
        explanation: stem,
        confidence: 0.92,
      }),
      f({
        id: "f2",
        filename: "auth/admin.ts",
        line: 12,
        explanation: stem,
        confidence: 0.88,
      }),
    ];

    const groups = planRootCauseClusters(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toHaveLength(2);
    expect(groups[0].keepId).toBe("f1");
    expect(groups[0].multiLocation).toHaveLength(2);
    expect(groups[0].shouldReverify).toBe(true);
    expect(groups[0].mergedSeverity).toBe("warning");
    expect(clusterDuplicateIds(groups)).toEqual(["f2"]);
  });

  it("elevates mergedSeverity to the highest member severity", () => {
    const stem =
      "Missing authorization check on admin endpoint before mutating protected resources";
    const findings = [
      f({
        id: "f1",
        filename: "auth/session.ts",
        line: 40,
        explanation: stem,
        confidence: 0.95,
        severity: "suggestion",
      }),
      f({
        id: "f2",
        filename: "auth/admin.ts",
        line: 12,
        explanation: stem,
        confidence: 0.9,
        severity: "blocker",
      }),
    ];
    const groups = planRootCauseClusters(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].keepId).toBe("f1");
    expect(groups[0].mergedSeverity).toBe("blocker");
  });

  it("does not merge unrelated categories/stems", () => {
    const findings = [
      f({
        id: "f1",
        category: "Security",
        explanation: "Hardcoded API secret embedded in client bundle configuration",
        confidence: 0.95,
      }),
      f({
        id: "f2",
        category: "Performance",
        filename: "b.ts",
        line: 20,
        explanation: "N plus one query pattern inside list rendering loop over users",
        confidence: 0.95,
      }),
    ];

    expect(planRootCauseClusters(findings)).toEqual([]);
  });

  it("does not merge low-confidence pairs", () => {
    const findings = [
      f({
        id: "f1",
        explanation: "Possible race on shared cache invalidation without lock guard",
        confidence: 0.4,
      }),
      f({
        id: "f2",
        filename: "b.ts",
        line: 22,
        explanation: "Possible race on shared cache invalidation without lock guard",
        confidence: 0.5,
      }),
    ];

    expect(planRootCauseClusters(findings)).toEqual([]);
  });

  it("does not merge when confidence is missing", () => {
    const findings = [
      f({
        id: "f1",
        explanation: "Unchecked error return ignored after database write transaction",
        confidence: null,
      }),
      f({
        id: "f2",
        filename: "b.ts",
        line: 5,
        explanation: "Unchecked error return ignored after database write transaction",
        confidence: 0.95,
      }),
    ];

    expect(planRootCauseClusters(findings)).toEqual([]);
  });

  it("keeps multi-location payload rather than silent-delete semantics", () => {
    const findings = [
      f({
        id: "keep-me",
        filename: "a.ts",
        line: 1,
        confidence: 0.99,
        explanation: "Resource leak: stream not closed on early return error path",
      }),
      f({
        id: "drop-me",
        filename: "b.ts",
        line: 2,
        confidence: 0.9,
        explanation: "Resource leak: stream not closed on early return error path",
      }),
    ];
    const groups = planRootCauseClusters(findings);
    expect(groups[0].keepId).toBe("keep-me");
    expect(groups[0].memberIds).toContain("drop-me");
    expect(groups[0].mergedEvidenceChain.map((l) => l.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("includes same-location losers in memberIds so they are deleted with the cluster", () => {
    const stem = "Missing null guard before nested property access on optional user";
    const findings = [
      f({ id: "loc-a-best", filename: "a.ts", line: 1, confidence: 0.95, explanation: stem }),
      f({
        id: "loc-a-worse",
        filename: "a.ts",
        line: 1,
        confidence: 0.86,
        explanation: stem,
        severity: "blocker",
        evidenceChain: JSON.stringify([{ file: "c.ts", line: 9, text: "extra hop" }]),
      }),
      f({ id: "loc-b", filename: "b.ts", line: 2, confidence: 0.9, explanation: stem }),
    ];
    const groups = planRootCauseClusters(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].keepId).toBe("loc-a-best");
    expect(groups[0].memberIds.sort()).toEqual(["loc-a-best", "loc-a-worse", "loc-b"].sort());
    expect(clusterDuplicateIds(groups).sort()).toEqual(["loc-a-worse", "loc-b"].sort());
    // Same-location losers still contribute severity + evidence before delete.
    expect(groups[0].mergedSeverity).toBe("blocker");
    expect(groups[0].mergedEvidenceChain.map((l) => l.file).sort()).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });
});
