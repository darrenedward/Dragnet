import { describe, it, expect } from "vitest";
import {
  pickCallOutcome,
  type SkepticOutcomeCounts,
} from "../src/services/findingVerifier/skepticTelemetry";

/**
 * Telemetry helper tests for the skeptic pass (issue #73).
 *
 * `pickCallOutcome` decides which `skeptic_*` outcome label appears on the
 * CostBanner chip for the fallback's pseudo-provider row. The rule is
 * "surface the dominant verdict kind; ties break toward actionability"
 * — so a split-decision scan with rejects and confirms is rendered as
 * `skeptic_reject`, not `skeptic_confirm`.
 */

function o(partial: Partial<SkepticOutcomeCounts>): SkepticOutcomeCounts {
  return {
    confirmed: 0,
    downgraded: 0,
    rejected: 0,
    skipped: 0,
    error: 0,
    ...partial,
  };
}

describe("skepticTelemetry — pickCallOutcome", () => {
  it("returns skeptic_confirm when confirms dominate alone", () => {
    expect(pickCallOutcome(o({ confirmed: 5 }))).toBe("skeptic_confirm");
  });

  it("returns skeptic_reject when rejects dominate", () => {
    expect(pickCallOutcome(o({ confirmed: 5, rejected: 6 }))).toBe("skeptic_reject");
  });

  it("returns skeptic_downgrade when downgrades dominate", () => {
    expect(pickCallOutcome(o({ confirmed: 1, downgraded: 3 }))).toBe("skeptic_downgrade");
  });

  it("breaks ties reject > downgrade > confirm (reject wins on tie)", () => {
    expect(pickCallOutcome(o({ confirmed: 3, downgraded: 3, rejected: 3 }))).toBe(
      "skeptic_reject",
    );
  });

  it("breaks ties downgrade > confirm (downgrade wins on tie)", () => {
    expect(pickCallOutcome(o({ confirmed: 2, downgraded: 2 }))).toBe("skeptic_downgrade");
  });

  it("returns skeptic_error when every verdict was discarded (no valid verdicts)", () => {
    expect(pickCallOutcome(o({ error: 5 }))).toBe("skeptic_error");
  });

  it("returns skeptic_error when all counts are zero", () => {
    expect(pickCallOutcome(o({}))).toBe("skeptic_error");
  });
});
