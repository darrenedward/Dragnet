import { describe, expect, it } from "vitest";
import { planIntraRunDedup } from "../../src/services/largePrReview/reconcile";
import { PUBLISH_ORDER } from "../../src/services/largePrReview/publishFindings";

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

  it("same fingerprint collapses to one survivor (publish step 1)", () => {
    const findings = [
      { id: "a", fingerprint: "fp-same", severity: "warning", confidence: 0.7, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "b", fingerprint: "fp-same", severity: "warning", confidence: 0.95, timestamp: "2026-01-01T00:00:01.000Z" },
    ];
    const dupes = planIntraRunDedup(findings);
    expect(dupes).toEqual(["a"]);
    const survivors = findings.filter((f) => !dupes.includes(f.id));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe("b");
  });

  it("distinct root fingerprints remain two survivors", () => {
    const findings = [
      { id: "a", fingerprint: "fp-root-1", severity: "blocker", confidence: 0.9, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "b", fingerprint: "fp-root-2", severity: "warning", confidence: 0.9, timestamp: "2026-01-01T00:00:01.000Z" },
    ];
    const dupes = planIntraRunDedup(findings);
    expect(dupes).toEqual([]);
    expect(findings).toHaveLength(2);
  });
});
