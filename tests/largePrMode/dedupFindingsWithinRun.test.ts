import { describe, expect, it } from "vitest";
import { planIntraRunDedup } from "../../src/services/largePrReview/reconcile";

describe("planIntraRunDedup", () => {
  it("returns empty array when no duplicates exist (all different fingerprints)", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-a", severity: "warning", confidence: 0.9, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-b", severity: "blocker", confidence: 0.8, timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "f3", fingerprint: "fp-c", severity: "suggestion", confidence: 0.7, timestamp: "2026-01-01T00:00:02.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    expect(dupes).toEqual([]);
  });

  it("keeps the highest-confidence finding when two share a fingerprint", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-x", severity: "warning", confidence: 0.7, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-x", severity: "warning", confidence: 0.9, timestamp: "2026-01-01T00:00:01.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    expect(dupes).toEqual(["f1"]);
  });

  it("uses severity as tiebreaker when confidence is equal", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-x", severity: "suggestion", confidence: 0.8, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-x", severity: "blocker", confidence: 0.8, timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "f3", fingerprint: "fp-x", severity: "warning", confidence: 0.8, timestamp: "2026-01-01T00:00:02.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    // f2 (blocker) should be kept; f1 (suggestion) and f3 (warning) are dupes
    expect(dupes).toContain("f1");
    expect(dupes).toContain("f3");
    expect(dupes).not.toContain("f2");
    expect(dupes).toHaveLength(2);
  });

  it("uses timestamp as final tiebreaker when confidence and severity are equal", () => {
    const findings = [
      { id: "f2", fingerprint: "fp-x", severity: "warning", confidence: 0.8, timestamp: "2026-06-02T00:00:00.000Z" },
      { id: "f1", fingerprint: "fp-x", severity: "warning", confidence: 0.8, timestamp: "2026-06-01T00:00:00.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    // f1 is earlier, so keep f1, delete f2
    expect(dupes).toEqual(["f2"]);
  });

  it("treats null confidence as -1 (lowest)", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-x", severity: "warning", confidence: null, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-x", severity: "warning", confidence: 0.5, timestamp: "2026-01-01T00:00:01.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    expect(dupes).toEqual(["f1"]);
  });

  it("handles unknown severity by ranking it below suggestion", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-x", severity: "unknown", confidence: 0.8, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-x", severity: "suggestion", confidence: 0.8, timestamp: "2026-01-01T00:00:01.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    // suggestion ranks higher than unknown (1 vs 0)
    expect(dupes).toEqual(["f1"]);
  });

  it("deduplicates multiple groups independently", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-a", severity: "warning", confidence: 0.9, timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "f2", fingerprint: "fp-a", severity: "warning", confidence: 0.7, timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "f3", fingerprint: "fp-b", severity: "blocker", confidence: 0.8, timestamp: "2026-01-01T00:00:02.000Z" },
      { id: "f4", fingerprint: "fp-b", severity: "blocker", confidence: 0.6, timestamp: "2026-01-01T00:00:03.000Z" },
      { id: "f5", fingerprint: "fp-c", severity: "suggestion", confidence: 0.5, timestamp: "2026-01-01T00:00:04.000Z" },
    ];

    const dupes = planIntraRunDedup(findings);

    // f2 is dup of f1; f4 is dup of f3; f5 is unique
    expect(dupes).toEqual(["f2", "f4"]);
  });

  it("returns empty array for empty input", () => {
    expect(planIntraRunDedup([])).toEqual([]);
  });

  it("returns empty array for single finding", () => {
    const findings = [
      { id: "f1", fingerprint: "fp-x", severity: "warning", confidence: 0.8, timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    expect(planIntraRunDedup(findings)).toEqual([]);
  });
});
