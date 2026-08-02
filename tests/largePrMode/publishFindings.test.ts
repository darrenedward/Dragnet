import { describe, expect, it } from "vitest";
import {
  clusterDuplicateIds,
  planRootCauseClusters,
  type ClusterFinding,
} from "../../src/services/largePrReview/cluster";
import { planIntraRunDedup } from "../../src/services/largePrReview/reconcile";
import {
  PUBLISH_ORDER,
  selectPublishedSurvivors,
} from "../../src/services/largePrReview/publishFindings";

describe("post-aggregate publish order", () => {
  it("documents fixed publish steps before findings are exposed", () => {
    expect([...PUBLISH_ORDER]).toEqual([
      "fingerprint_dedupe",
      "root_cause_cluster",
      "reverify_survivors",
      "cross_run_reconcile",
      "load_published",
    ]);
  });

  it("cluster step plans multi-location merge then marks non-keep members for removal", () => {
    const stem = "Missing authz check before mutating protected admin resources safely";
    const findings: ClusterFinding[] = [
      {
        id: "keep",
        fingerprint: "fp-a",
        category: "Security",
        severity: "blocker",
        filename: "a.ts",
        line: 1,
        explanation: stem,
        confidence: 0.95,
        evidenceChain: null,
      },
      {
        id: "drop",
        fingerprint: "fp-b",
        category: "Security",
        severity: "warning",
        filename: "b.ts",
        line: 2,
        explanation: stem,
        confidence: 0.9,
        evidenceChain: null,
      },
    ];
    const groups = planRootCauseClusters(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].shouldReverify).toBe(true);
    expect(groups[0].mergedSeverity).toBe("blocker");
    const afterCluster = selectPublishedSurvivors(findings, clusterDuplicateIds(groups));
    expect(afterCluster.map((f) => f.id)).toEqual(["keep"]);
    expect(groups[0].multiLocation.map((l) => l.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("same fingerprint collapses to one survivor (publish step 1)", () => {
    const findings = [
      {
        id: "a",
        fingerprint: "fp-same",
        severity: "warning",
        confidence: 0.7,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "b",
        fingerprint: "fp-same",
        severity: "warning",
        confidence: 0.95,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    const dupes = planIntraRunDedup(findings);
    expect(dupes).toEqual(["a"]);
    const survivors = selectPublishedSurvivors(findings, dupes);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe("b");
  });

  it("distinct root fingerprints remain two survivors", () => {
    const findings = [
      {
        id: "a",
        fingerprint: "fp-root-1",
        severity: "blocker",
        confidence: 0.9,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "b",
        fingerprint: "fp-root-2",
        severity: "warning",
        confidence: 0.9,
        timestamp: "2026-01-01T00:00:01.000Z",
      },
    ];
    const dupes = planIntraRunDedup(findings);
    expect(dupes).toEqual([]);
    const survivors = selectPublishedSurvivors(findings, dupes);
    expect(survivors).toHaveLength(2);
    expect(survivors.map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("multi-chunk same-bug reports collapse; distinct roots stay separate", () => {
    // Simulates two chunks reporting the same bug (fp-x) plus a third distinct root.
    const findings = [
      {
        id: "chunk1-fp-x",
        fingerprint: "fp-x",
        severity: "warning",
        confidence: 0.8,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "chunk2-fp-x",
        fingerprint: "fp-x",
        severity: "warning",
        confidence: 0.91,
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "chunk2-fp-y",
        fingerprint: "fp-y",
        severity: "blocker",
        confidence: 0.88,
        timestamp: "2026-01-01T00:00:03.000Z",
      },
    ];
    const dupes = planIntraRunDedup(findings);
    const survivors = selectPublishedSurvivors(findings, dupes);
    expect(dupes).toEqual(["chunk1-fp-x"]);
    expect(survivors).toHaveLength(2);
    expect(survivors.map((f) => f.fingerprint).sort()).toEqual(["fp-x", "fp-y"]);
    expect(survivors.find((f) => f.fingerprint === "fp-x")?.id).toBe("chunk2-fp-x");
  });
});
