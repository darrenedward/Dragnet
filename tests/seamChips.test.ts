import { describe, expect, it } from "vitest";
import { buildSeamChips } from "../src/lib/seamChips";

describe("buildSeamChips", () => {
  const healthy = {
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
  };

  it("returns five seams in order: clone webhook index checks rating", () => {
    const chips = buildSeamChips(healthy);
    expect(chips.map((c) => c.id)).toEqual([
      "clone",
      "webhook",
      "index",
      "checks",
      "rating",
    ]);
    expect(chips.every((c) => c.tone === "ok")).toBe(true);
  });

  it("marks clone failed when lastFetchError is set", () => {
    const chips = buildSeamChips({ ...healthy, lastFetchError: "auth failed" });
    expect(chips.find((c) => c.id === "clone")).toMatchObject({
      tone: "fail",
      detail: "failed",
    });
  });

  it("marks webhook off when not configured on a remote repo", () => {
    const chips = buildSeamChips({
      ...healthy,
      webhookEnabled: false,
      webhookId: null,
    });
    expect(chips.find((c) => c.id === "webhook")).toMatchObject({
      tone: "warn",
      detail: "off",
    });
  });

  it("marks webhook n/a for local repos without a hook", () => {
    const chips = buildSeamChips({
      hasCheckout: true,
      provider: "local",
      cloneUrl: null,
      webhookId: null,
      webhookEnabled: false,
      indexedAt: "2026-07-01T00:00:00Z",
    });
    expect(chips.find((c) => c.id === "webhook")).toMatchObject({
      tone: "na",
      detail: "n/a",
    });
  });

  it("marks index required when indexedAt is missing", () => {
    const chips = buildSeamChips({ ...healthy, indexedAt: null });
    expect(chips.find((c) => c.id === "index")).toMatchObject({
      tone: "fail",
      detail: "required",
    });
  });

  it("marks checks done for scan finished without implying merge-ready", () => {
    const chips = buildSeamChips({
      ...healthy,
      rating: null,
      runOutcome: "reviewed",
    });
    expect(chips.find((c) => c.id === "checks")).toMatchObject({
      tone: "ok",
      detail: "done",
    });
    expect(chips.find((c) => c.id === "rating")?.tone).toBe("fail");
    expect(chips.find((c) => c.id === "rating")?.title).toMatch(/not merge-ready/i);
  });

  it("rating ok only when isMergeReady passes (not rating folklore alone)", () => {
    const low = buildSeamChips({ ...healthy, rating: 7 });
    expect(low.find((c) => c.id === "rating")?.tone).toBe("fail");

    const skipped = buildSeamChips({
      ...healthy,
      rating: 10,
      runOutcome: "skipped",
    });
    expect(skipped.find((c) => c.id === "rating")?.tone).toBe("fail");

    const ok = buildSeamChips(healthy);
    expect(ok.find((c) => c.id === "rating")).toMatchObject({
      tone: "ok",
      detail: "9/10",
    });
  });

  it("surfaces blockedGate on the matching seam", () => {
    const chips = buildSeamChips({
      ...healthy,
      indexedAt: null,
      blockedGate: "INDEX_REQUIRED",
    });
    expect(chips.find((c) => c.id === "index")).toMatchObject({
      tone: "fail",
      detail: "blocked",
    });
  });
});
