import { describe, expect, it } from "vitest";
import {
  buildPrWorkspaceHeaderModel,
  isCloneFailedForActions,
} from "../src/lib/prWorkspaceHeader";
import type { SeamChipInput } from "../src/lib/seamChips";

const LAYOUT_C_ORDER = [
  "status",
  "size",
  "webhook",
  "cloned",
  "indexed",
  "rating",
  "merge",
] as const;

function healthySeam(overrides: SeamChipInput = {}): SeamChipInput {
  return {
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
    refused: false,
    stale: false,
    ...overrides,
  };
}

describe("buildPrWorkspaceHeaderModel", () => {
  it("returns single ordered chip row (status · size · webhook · cloned · indexed · rating · merge)", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "Promote endpoint",
      sourceBranch: "ticket-24-promote",
      githubPrNumber: 30,
      status: "Completed",
      sizeTier: "small",
      seam: healthySeam({ rating: 9 }),
      rating: 9,
    });
    expect(model.chips.map((c) => c.id)).toEqual([...LAYOUT_C_ORDER]);
    expect(model.chips).toHaveLength(7);
  });

  it("does not emit duplicate merge-ready or scan-finished soup", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "ticket-1-x",
      status: "Completed",
      sizeTier: "medium",
      seam: healthySeam({ rating: 9 }),
      rating: 9,
    });
    expect(model.chips.filter((c) => c.id === "merge")).toHaveLength(1);
    expect(model.chips.filter((c) => /merge ready/i.test(c.label))).toHaveLength(1);
    expect(model.chips.find((c) => c.id === "status")?.label).toBe("completed");
    expect(model.chips.some((c) => /scan finished/i.test(c.label))).toBe(false);
  });

  it("identity shows GitHub PR: #N — title and GitHub Issue: #M — branch when known", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "Promote endpoint: ambassadors",
      sourceBranch: "ticket-24-promote",
      githubPrNumber: 30,
      status: "Completed",
      seam: healthySeam(),
      rating: 9,
    });
    expect(model.identity.prLine).toBe(
      "GitHub PR: #30 — Promote endpoint: ambassadors",
    );
    expect(model.identity.issueLine).toBe(
      "GitHub Issue: #24 — ticket-24-promote",
    );
  });

  it("rating 6 completed → completed + amber 6/10 + not ready (shared gate)", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Completed",
      sizeTier: "small",
      seam: healthySeam({ rating: 6 }),
      rating: 6,
    });
    expect(model.chips.find((c) => c.id === "status")?.label).toBe("completed");
    expect(model.chips.find((c) => c.id === "rating")).toMatchObject({
      label: "6/10",
      tone: "amber",
    });
    expect(model.chips.find((c) => c.id === "merge")).toMatchObject({
      label: "not ready",
    });
    expect(model.chips.find((c) => c.id === "merge")?.tone).not.toBe("green");
    // No free-text merge reason as a separate chip/label line
    expect(model.chips.find((c) => c.id === "merge")?.label).toBe("not ready");
  });

  it("rating 9 gate pass → merge ready", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Completed",
      seam: healthySeam({ rating: 9 }),
      rating: 9,
    });
    expect(model.chips.find((c) => c.id === "merge")).toMatchObject({
      label: "merge ready",
      tone: "green",
    });
  });

  it("null rating is not merge-ready", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Completed",
      seam: healthySeam({ rating: null }),
      rating: null,
    });
    expect(model.chips.find((c) => c.id === "rating")?.label).toBe("no score");
    expect(model.chips.find((c) => c.id === "merge")?.label).toBe("not ready");
  });

  it("clone failed disables run actions", () => {
    const seam = healthySeam({ lastFetchError: "auth failed" });
    expect(isCloneFailedForActions(seam)).toBe(true);
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Pending",
      seam,
      rating: null,
    });
    expect(model.cloneFailed).toBe(true);
    expect(model.chips.find((c) => c.id === "cloned")?.label).toBe("clone failed");
  });

  it("blocked gate surfaces on merge chip only", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Failed",
      seam: healthySeam({
        indexedAt: null,
        blockedGate: "INDEX_REQUIRED",
        rating: null,
      }),
      rating: null,
      blockedGate: "INDEX_REQUIRED",
    });
    const merge = model.chips.find((c) => c.id === "merge");
    expect(merge?.label).toMatch(/Blocked at INDEX_REQUIRED/i);
    expect(model.chips.filter((c) => c.id === "merge")).toHaveLength(1);
    expect(model.chips.map((c) => c.id)).toEqual([...LAYOUT_C_ORDER]);
  });

  it("no run status → no_run merge (not false merge-ready from bare rating)", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Pending",
      sizeTier: "small",
      seam: healthySeam({
        runStatus: undefined,
        runOutcome: undefined,
        rating: undefined,
        reliability: undefined,
      }),
      // Stale PR-row score must not satisfy the gate without a finished run.
      rating: 9,
    });
    expect(model.chips.find((c) => c.id === "merge")).toMatchObject({
      label: "not ready",
    });
    expect(model.chips.find((c) => c.id === "merge")?.tone).not.toBe("green");
    expect(model.chips.find((c) => c.id === "merge")?.tooltip.toLowerCase()).toMatch(
      /no completed review|not merge-ready|no_run|not ready/,
    );
  });

  it("explicit null run rating stays no score (does not inherit a prior score)", () => {
    const model = buildPrWorkspaceHeaderModel({
      title: "x",
      sourceBranch: "main",
      status: "Completed",
      seam: healthySeam({ rating: null, runOutcome: "skipped" }),
      rating: null,
    });
    expect(model.chips.find((c) => c.id === "rating")?.label).toBe("no score");
    expect(model.chips.find((c) => c.id === "merge")?.label).toBe("not ready");
  });
});

describe("isCloneFailedForActions", () => {
  it("true only when clone seam tone is fail", () => {
    expect(isCloneFailedForActions(healthySeam())).toBe(false);
    expect(
      isCloneFailedForActions(healthySeam({ lastFetchError: "boom" })),
    ).toBe(true);
    expect(
      isCloneFailedForActions(healthySeam({ repoStatus: "error" })),
    ).toBe(true);
  });
});
