import { describe, expect, it } from "vitest";
import {
  presentRatingPill,
  presentSizePill,
  presentStatusPill,
  type LayoutCPillTone,
} from "../src/lib/layoutCPills";

const NON_GREEN: LayoutCPillTone[] = ["amber", "blue", "red"];

describe("presentStatusPill", () => {
  it("maps Pending → pending amber", () => {
    const pill = presentStatusPill({ status: "Pending" });
    expect(pill.kind).toBe("pending");
    expect(pill.label).toBe("pending");
    expect(pill.tone).toBe("amber");
    expect(pill.tooltip.toLowerCase()).toContain("pending");
  });

  it("maps In Progress → processing blue", () => {
    const pill = presentStatusPill({ status: "In Progress" });
    expect(pill.kind).toBe("processing");
    expect(pill.label).toBe("processing");
    expect(pill.tone).toBe("blue");
  });

  it("includes queue position on processing when known", () => {
    const pill = presentStatusPill({
      status: "In Progress",
      queuePosition: 2,
      queueState: "running",
    });
    expect(pill.kind).toBe("processing");
    expect(pill.label).toBe("processing #2");
    expect(pill.tone).toBe("blue");
    expect(pill.tooltip).toMatch(/#2/);
  });

  it("surfaces queue wait reason with concurrent slot limits", () => {
    const pill = presentStatusPill({
      status: "Pending",
      queueState: "queued",
      queuePosition: 3,
      queueGlobalLimit: 2,
      queueRepoLimit: 1,
    });
    expect(pill.kind).toBe("processing");
    expect(pill.tooltip.toLowerCase()).toMatch(/concurrent/);
    expect(pill.tooltip).toMatch(/#3/);
    expect(pill.tooltip).toMatch(/Global limit 2/);
  });

  it("terminalClass hard_fail overrides Completed PR status to failed red", () => {
    const pill = presentStatusPill({
      status: "Completed",
      terminalClass: "hard_fail",
      terminalReason: "hard_fail: dual quality_failure",
    });
    expect(pill.kind).toBe("failed");
    expect(pill.tone).toBe("red");
    expect(pill.tooltip).toMatch(/hard_fail|quality/i);
  });

  it("treats active queue job as processing even when PR status is still Pending", () => {
    const queued = presentStatusPill({
      status: "Pending",
      queueState: "queued",
      queuePosition: 3,
    });
    expect(queued.kind).toBe("processing");
    expect(queued.label).toBe("processing #3");
    expect(queued.tone).toBe("blue");

    const running = presentStatusPill({
      status: "Pending",
      queueState: "running",
      queuePosition: 1,
    });
    expect(running.kind).toBe("processing");
    expect(running.label).toBe("processing #1");
  });

  it("maps Completed → completed green (scan finished ≠ merge-ready)", () => {
    const pill = presentStatusPill({ status: "Completed" });
    expect(pill.kind).toBe("completed");
    expect(pill.label).toBe("completed");
    expect(pill.tone).toBe("green");
    expect(pill.tooltip.toLowerCase()).toMatch(/merge/);
  });

  it("maps legacy scanned status to completed green", () => {
    const pill = presentStatusPill({ status: "scanned" });
    expect(pill.kind).toBe("completed");
    expect(pill.tone).toBe("green");
  });

  it("maps Failed to non-green failed (must not look completed)", () => {
    const pill = presentStatusPill({ status: "Failed" });
    expect(pill.kind).toBe("failed");
    expect(pill.label).toBe("failed");
    expect(pill.tone).toBe("red");
    expect(NON_GREEN).toContain(pill.tone);
    expect(pill.tone).not.toBe("green");
  });

  it("maps Merged to explicit non-green lifecycle state", () => {
    const pill = presentStatusPill({ status: "Merged" });
    expect(pill.kind).toBe("merged");
    expect(pill.label).toBe("merged");
    expect(pill.tone).not.toBe("green");
    expect(NON_GREEN).toContain(pill.tone);
  });

  it("maps unknown / open-like statuses to pending amber (not green)", () => {
    for (const status of ["open", "Pending", "unknown-xyz", ""]) {
      const pill = presentStatusPill({ status });
      if (status === "open" || status === "Pending" || status === "unknown-xyz" || status === "") {
        expect(pill.tone).not.toBe("green");
      }
    }
    expect(presentStatusPill({ status: "open" }).kind).toBe("pending");
  });

  it("terminal queue failure with Failed PR stays failed red", () => {
    const pill = presentStatusPill({
      status: "Failed",
      queueState: "failed",
      queuePosition: null,
    });
    expect(pill.kind).toBe("failed");
    expect(pill.tone).toBe("red");
  });

  it("re-admitted Failed PR with active queue shows processing (not stuck failed)", () => {
    const queued = presentStatusPill({
      status: "Failed",
      queueState: "queued",
      queuePosition: 2,
    });
    expect(queued.kind).toBe("processing");
    expect(queued.label).toBe("processing #2");
    expect(queued.tone).toBe("blue");

    const running = presentStatusPill({
      status: "Failed",
      queueState: "running",
      queuePosition: 1,
    });
    expect(running.kind).toBe("processing");
    expect(running.tone).toBe("blue");
  });
});

describe("presentRatingPill", () => {
  it("null → no score amber with merge-bar tooltip", () => {
    const pill = presentRatingPill(null);
    expect(pill.label).toBe("no score");
    expect(pill.tone).toBe("amber");
    expect(pill.tooltip.toLowerCase()).toMatch(/8\+/);
    expect(pill.score).toBeNull();
  });

  it("undefined → no score amber", () => {
    const pill = presentRatingPill(undefined);
    expect(pill.label).toBe("no score");
    expect(pill.tone).toBe("amber");
  });

  it("1–4 red", () => {
    for (const n of [1, 2, 3, 4]) {
      const pill = presentRatingPill(n);
      expect(pill.tone).toBe("red");
      expect(pill.label).toBe(`${n}/10`);
      expect(pill.score).toBe(n);
    }
  });

  it("5–7 amber (below merge bar)", () => {
    for (const n of [5, 6, 7]) {
      const pill = presentRatingPill(n);
      expect(pill.tone).toBe("amber");
      expect(pill.label).toBe(`${n}/10`);
      expect(pill.tooltip).toMatch(/8\+/);
    }
  });

  it("8–10 green (at/above merge bar)", () => {
    for (const n of [8, 9, 10]) {
      const pill = presentRatingPill(n);
      expect(pill.tone).toBe("green");
      expect(pill.label).toBe(`${n}/10`);
      expect(pill.tooltip.toLowerCase()).toMatch(/merge/);
    }
  });

  it("bands use raw score like isMergeReady (no round-up into green)", () => {
    // 7.6 < 8 ⇒ not merge-ready; must not display as green 8/10
    const below = presentRatingPill(7.6);
    expect(below.tone).toBe("amber");
    expect(below.tone).not.toBe("green");
    expect(below.label).toBe("7.6/10");
    expect(below.score).toBe(7.6);

    const atBar = presentRatingPill(8);
    expect(atBar.tone).toBe("green");
    expect(atBar.label).toBe("8/10");
  });
});

describe("presentSizePill", () => {
  it("small → green small band", () => {
    const pill = presentSizePill("small");
    expect(pill.band).toBe("small");
    expect(pill.label).toBe("small");
    expect(pill.tone).toBe("green");
  });

  it("medium → amber medium band", () => {
    const pill = presentSizePill("medium");
    expect(pill.band).toBe("medium");
    expect(pill.label).toBe("medium");
    expect(pill.tone).toBe("amber");
  });

  it("oversized → red oversized band", () => {
    const pill = presentSizePill("oversized");
    expect(pill.band).toBe("oversized");
    expect(pill.label).toBe("oversized");
    expect(pill.tone).toBe("red");
  });

  it("maps production large tier into oversized (red) visual band", () => {
    // Agreed layout-C collapse: production has four tiers (small|medium|large|oversized)
    // but pills use three visual bands. large → oversized/red (quality-risk band).
    const pill = presentSizePill("large");
    expect(pill.band).toBe("oversized");
    expect(pill.tone).toBe("red");
    expect(pill.label).toBe("large");
    expect(pill.tooltip.toLowerCase()).toMatch(/large|degrad|split|over/);
  });

  it("accepts PrSizeProfile-shaped input via tier field", () => {
    const pill = presentSizePill({ tier: "medium" });
    expect(pill.band).toBe("medium");
    expect(pill.tone).toBe("amber");
  });
});
