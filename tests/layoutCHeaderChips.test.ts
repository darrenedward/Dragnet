import { describe, expect, it } from "vitest";
import { buildSeamChips } from "../src/lib/seamChips";
import { isMergeReady } from "../src/lib/mergeReady";
import { buildLayoutCHeaderChips } from "../src/lib/layoutCHeaderChips";

const LAYOUT_C_ORDER = [
  "status",
  "size",
  "webhook",
  "cloned",
  "indexed",
  "rating",
  "merge",
] as const;

function healthySeams(overrides: Parameters<typeof buildSeamChips>[0] = {}) {
  return buildSeamChips({
    hasCheckout: true,
    cloneUrl: "https://github.com/acme/app.git",
    provider: "github",
    webhookEnabled: true,
    webhookId: "42",
    indexedAt: "2026-07-01T00:00:00Z",
    runStatus: "completed",
    runOutcome: "reviewed",
    rating: 9,
    reliability: "complete",
    ...overrides,
  });
}

function readyMerge(overrides: Parameters<typeof isMergeReady>[0] = {}) {
  return isMergeReady({
    status: "completed",
    outcome: "reviewed",
    rating: 9,
    reliability: "complete",
    refused: false,
    stale: false,
    ...overrides,
  });
}

function baseInput(
  overrides: Partial<Parameters<typeof buildLayoutCHeaderChips>[0]> = {},
) {
  return {
    seams: healthySeams(),
    merge: readyMerge(),
    status: "Completed",
    size: "small" as const,
    rating: 9,
    ...overrides,
  };
}

describe("buildLayoutCHeaderChips", () => {
  it("returns one ordered layout-C chip list (status · size · webhook · cloned · indexed · rating · merge)", () => {
    const chips = buildLayoutCHeaderChips(baseInput());
    expect(chips.map((c) => c.id)).toEqual([...LAYOUT_C_ORDER]);
    expect(chips).toHaveLength(7);
  });

  it("does not emit duplicate merge-ready badges", () => {
    const chips = buildLayoutCHeaderChips(baseInput());
    const mergeChips = chips.filter((c) => c.id === "merge");
    expect(mergeChips).toHaveLength(1);
    expect(chips.filter((c) => /merge ready/i.test(c.label))).toHaveLength(1);
    // Status stays "completed" (scan finished) — not a second merge-ready badge
    expect(chips.find((c) => c.id === "status")?.label).toBe("completed");
    expect(chips.find((c) => c.id === "merge")?.label).toBe("merge ready");
  });

  it("surfaces tip mismatch on merge and rating chips when stale", () => {
    const staleMerge = readyMerge({ stale: true, staleReason: "tip_mismatch" });
    const chips = buildLayoutCHeaderChips(
      baseInput({
        merge: staleMerge,
        rating: 9,
        stale: true,
        staleReason: "tip_mismatch",
        seams: healthySeams({ rating: 9, stale: true, staleReason: "tip_mismatch" }),
      }),
    );
    expect(chips.find((c) => c.id === "merge")).toMatchObject({
      label: "tip mismatch",
      tone: "amber",
    });
    expect(chips.find((c) => c.id === "merge")?.tooltip).toMatch(/tip/i);
    expect(chips.find((c) => c.id === "rating")?.label).toBe("tip stale");
  });

  it("merge ready chip is true only when shared isMergeReady gate passes", () => {
    const ok = buildLayoutCHeaderChips(baseInput());
    expect(ok.find((c) => c.id === "merge")).toMatchObject({
      label: "merge ready",
      tone: "green",
    });

    const low = buildLayoutCHeaderChips(
      baseInput({
        merge: readyMerge({ rating: 7 }),
        rating: 7,
        seams: healthySeams({ rating: 7 }),
      }),
    );
    expect(low.find((c) => c.id === "merge")).toMatchObject({
      label: "not ready",
    });
    expect(low.find((c) => c.id === "merge")?.tone).not.toBe("green");

    const skipped = buildLayoutCHeaderChips(
      baseInput({
        merge: readyMerge({ outcome: "skipped", rating: 10 }),
        rating: 10,
        seams: healthySeams({ runOutcome: "skipped", rating: 10 }),
      }),
    );
    expect(skipped.find((c) => c.id === "merge")?.label).toBe("not ready");
  });

  it("null rating → no score on rating chip; merge is not ready (reason in tooltip)", () => {
    const merge = readyMerge({ rating: null });
    const chips = buildLayoutCHeaderChips(
      baseInput({
        merge,
        rating: null,
        seams: healthySeams({ rating: null }),
      }),
    );
    expect(chips.find((c) => c.id === "rating")).toMatchObject({
      label: "no score",
      tone: "amber",
    });
    const mergeChip = chips.find((c) => c.id === "merge");
    expect(mergeChip?.label).toBe("not ready");
    expect(mergeChip?.tooltip.toLowerCase()).toMatch(/rating|score|merge/);
    // Tooltip carries detail — label is not a free-text reason line
    expect(mergeChip?.label).not.toMatch(/Rating unavailable|below the merge/i);
  });

  it("rating below 8 → not ready with tooltip (not free-text reason line)", () => {
    const merge = readyMerge({ rating: 6 });
    const chips = buildLayoutCHeaderChips(
      baseInput({
        merge,
        rating: 6,
        seams: healthySeams({ rating: 6 }),
      }),
    );
    expect(chips.find((c) => c.id === "rating")).toMatchObject({
      label: "6/10",
      tone: "amber",
    });
    const mergeChip = chips.find((c) => c.id === "merge");
    expect(mergeChip?.label).toBe("not ready");
    expect(mergeChip?.tooltip).toMatch(/6/);
    expect(mergeChip?.label).toBe("not ready");
  });

  it("maps seam chips into webhook · cloned · indexed labels", () => {
    const chips = buildLayoutCHeaderChips(baseInput());
    expect(chips.find((c) => c.id === "webhook")).toMatchObject({
      label: "webhook on",
      tone: "green",
    });
    expect(chips.find((c) => c.id === "cloned")).toMatchObject({
      label: "cloned",
      tone: "green",
    });
    expect(chips.find((c) => c.id === "indexed")).toMatchObject({
      label: "indexed",
      tone: "green",
    });
  });

  it("surfaces clone / webhook / index fail tones from seams", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        seams: healthySeams({
          lastFetchError: "auth failed",
          webhookEnabled: false,
          webhookId: null,
          indexedAt: null,
        }),
        merge: readyMerge({ rating: null }),
        rating: null,
      }),
    );
    expect(chips.find((c) => c.id === "cloned")?.tone).toBe("red");
    expect(chips.find((c) => c.id === "webhook")?.tone).toBe("amber");
    expect(chips.find((c) => c.id === "indexed")?.tone).toBe("red");
  });

  it("preserves blocked-at-{gate} as a single clear merge-chip signal", () => {
    const merge = readyMerge();
    const chips = buildLayoutCHeaderChips(
      baseInput({
        merge,
        blockedGate: "INDEX_REQUIRED",
        seams: healthySeams({
          indexedAt: null,
          blockedGate: "INDEX_REQUIRED",
        }),
      }),
    );
    const mergeChip = chips.find((c) => c.id === "merge");
    expect(mergeChip?.label).toMatch(/Blocked at INDEX_REQUIRED/i);
    expect(mergeChip?.tooltip).toMatch(/Blocked at INDEX_REQUIRED/i);
    // Single signal — no extra merge-ready chip alongside blocked
    expect(chips.filter((c) => c.id === "merge")).toHaveLength(1);
    expect(chips.some((c) => c.label === "merge ready")).toBe(false);
  });

  it("folds checks detail into tooltip rather than a second badge row", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        merge: readyMerge({ rating: 7 }),
        rating: 7,
        seams: healthySeams({
          rating: 7,
          runStatus: "failed",
          checksFailed: true,
        }),
      }),
    );
    expect(chips.map((c) => c.id)).not.toContain("checks");
    expect(chips).toHaveLength(7);
    const mergeTip = chips.find((c) => c.id === "merge")?.tooltip ?? "";
    expect(mergeTip.toLowerCase()).toMatch(/check|fail|scan|ready/);
  });

  it("status + size come from layout-C pill presenters (queue-aware)", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        status: "Pending",
        queueState: "queued",
        queuePosition: 2,
        size: "oversized",
        merge: isMergeReady(null),
        rating: null,
        seams: healthySeams({
          runStatus: undefined,
          runOutcome: undefined,
          rating: null,
        }),
      }),
    );
    expect(chips.find((c) => c.id === "status")).toMatchObject({
      label: "processing #2",
      tone: "blue",
    });
    expect(chips.find((c) => c.id === "size")).toMatchObject({
      label: "oversized",
      tone: "red",
    });
    // Scan-in-flight is not merge-ready
    expect(chips.find((c) => c.id === "merge")?.label).toBe("not ready");
  });

  it("scan finished (completed status) is not merge ready when gate fails", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        status: "Completed",
        merge: readyMerge({ rating: 5 }),
        rating: 5,
        seams: healthySeams({ rating: 5 }),
      }),
    );
    expect(chips.find((c) => c.id === "status")?.label).toBe("completed");
    expect(chips.find((c) => c.id === "merge")?.label).toBe("not ready");
  });

  it("accepts sizeProfile-shaped size input", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({ size: { tier: "medium" } }),
    );
    expect(chips.find((c) => c.id === "size")).toMatchObject({
      label: "medium",
      tone: "amber",
    });
  });

  it("terminalClass hard_fail overrides Completed PR status (#140)", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        status: "Completed",
        terminalClass: "hard_fail",
        terminalReason: "hard_fail: dual quality_failure",
        rating: null,
        merge: readyMerge({ rating: null }),
      }),
    );
    expect(chips.find((c) => c.id === "status")).toMatchObject({
      label: "failed",
      tone: "red",
    });
    expect(chips.find((c) => c.id === "status")?.tooltip).toMatch(/hard_fail|quality/i);
  });

  it("queued status surfaces concurrent slot wait reason (#140)", () => {
    const chips = buildLayoutCHeaderChips(
      baseInput({
        status: "Pending",
        queueState: "queued",
        queuePosition: 2,
        queueGlobalLimit: 1,
        queueRepoLimit: 1,
        terminalClass: "queued",
        terminalReason: "queue position #2 — waiting for a global concurrent slot (limit 1)",
      }),
    );
    const status = chips.find((c) => c.id === "status");
    expect(status?.label).toMatch(/processing/i);
    expect(status?.tone).toBe("blue");
    expect(status?.tooltip.toLowerCase()).toMatch(/concurrent|queue/);
  });
});
