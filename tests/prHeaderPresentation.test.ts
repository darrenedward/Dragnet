import { describe, expect, it } from "vitest";
import {
  buildLayoutCChips,
  buildSidebarPrRow,
  formatPrIdentity,
  isCloneFailedForActions,
  mapPrStatusPill,
  mapRatingPill,
  mapSizeBand,
  parseTicketFromBranch,
  type LayoutCChipInput,
} from "../src/lib/prHeaderPresentation";

describe("parseTicketFromBranch", () => {
  it("extracts ticket-N from branch names", () => {
    expect(parseTicketFromBranch("ticket-24-promote")).toBe(24);
    expect(parseTicketFromBranch("ticket-146-correspondence")).toBe(146);
    expect(parseTicketFromBranch("feature/ticket-7-foo")).toBe(7);
  });

  it("returns null when no reliable ticket pattern", () => {
    expect(parseTicketFromBranch("chore/deps")).toBeNull();
    expect(parseTicketFromBranch("main")).toBeNull();
    expect(parseTicketFromBranch("")).toBeNull();
    expect(parseTicketFromBranch(null)).toBeNull();
    expect(parseTicketFromBranch("ticket-abc-x")).toBeNull();
  });

  it("never invents IDs from bare numbers without ticket- prefix", () => {
    expect(parseTicketFromBranch("pr-30-promote")).toBeNull();
    expect(parseTicketFromBranch("24-promote")).toBeNull();
  });
});

describe("formatPrIdentity", () => {
  it("formats GitHub PR line with number and title", () => {
    const id = formatPrIdentity({
      title: "Promote endpoint: ambassadors",
      githubPrNumber: 30,
      sourceBranch: "ticket-24-promote",
    });
    expect(id.prLine).toBe("GitHub PR: #30 — Promote endpoint: ambassadors");
    expect(id.issueLine).toBe("GitHub Issue: #24 — ticket-24-promote");
    expect(id.ticketNumber).toBe(24);
    expect(id.branchFallback).toBeNull();
  });

  it("uses branch fallback without empty Issue line when no ticket", () => {
    const id = formatPrIdentity({
      title: "chore: deps bump",
      githubPrNumber: 41,
      sourceBranch: "chore/deps",
    });
    expect(id.prLine).toBe("GitHub PR: #41 — chore: deps bump");
    expect(id.issueLine).toBeNull();
    expect(id.branchFallback).toBe("chore/deps");
  });

  it("omits PR number gracefully when null", () => {
    const id = formatPrIdentity({
      title: "Local branch work",
      githubPrNumber: null,
      sourceBranch: "ticket-9-local",
    });
    expect(id.prLine).toBe("GitHub PR: Local branch work");
    expect(id.issueLine).toBe("GitHub Issue: #9 — ticket-9-local");
  });

  it("prefers explicit ticketNumber over branch parse", () => {
    const id = formatPrIdentity({
      title: "x",
      githubPrNumber: 1,
      sourceBranch: "ticket-99-x",
      ticketNumber: 42,
    });
    expect(id.ticketNumber).toBe(42);
    expect(id.issueLine).toBe("GitHub Issue: #42 — ticket-99-x");
  });
});

describe("mapRatingPill", () => {
  it("maps null to no score amber", () => {
    expect(mapRatingPill(null)).toMatchObject({ label: "no score", tone: "amber" });
    expect(mapRatingPill(undefined)).toMatchObject({ label: "no score", tone: "amber" });
  });

  it("maps 1–4 red, 5–7 amber, 8–10 green", () => {
    expect(mapRatingPill(1).tone).toBe("red");
    expect(mapRatingPill(4).tone).toBe("red");
    expect(mapRatingPill(5).tone).toBe("amber");
    expect(mapRatingPill(7).tone).toBe("amber");
    expect(mapRatingPill(8).tone).toBe("green");
    expect(mapRatingPill(10).tone).toBe("green");
    expect(mapRatingPill(7).label).toBe("7/10");
  });
});

describe("mapSizeBand", () => {
  it("maps small green, medium amber, oversized red", () => {
    expect(mapSizeBand("small")).toMatchObject({ label: "small", tone: "green" });
    expect(mapSizeBand("medium")).toMatchObject({ label: "medium", tone: "amber" });
    expect(mapSizeBand("oversized")).toMatchObject({ label: "oversized", tone: "red" });
  });

  it("maps production large into amber band (same visual band as medium)", () => {
    // large is between medium and oversized; keep amber so only oversized is red.
    expect(mapSizeBand("large")).toMatchObject({ label: "large", tone: "amber" });
  });

  it("returns null when tier missing", () => {
    expect(mapSizeBand(null)).toBeNull();
    expect(mapSizeBand(undefined)).toBeNull();
  });
});

describe("mapPrStatusPill", () => {
  it("maps Pending → pending amber", () => {
    expect(mapPrStatusPill({ status: "Pending" })).toMatchObject({
      kind: "pending",
      label: "pending",
      tone: "amber",
    });
  });

  it("maps In Progress / queue → processing blue with optional #N", () => {
    expect(
      mapPrStatusPill({
        status: "Pending",
        queueState: "queued",
        queuePosition: 2,
      }),
    ).toMatchObject({
      kind: "processing",
      label: "processing #2",
      tone: "blue",
    });
    expect(
      mapPrStatusPill({ status: "In Progress", queueState: "running" }),
    ).toMatchObject({ kind: "processing", label: "processing", tone: "blue" });
  });

  it("maps Completed → completed green (not merge-ready)", () => {
    expect(mapPrStatusPill({ status: "Completed" })).toMatchObject({
      kind: "completed",
      label: "completed",
      tone: "green",
    });
  });

  it("maps Failed → failed red (never completed green)", () => {
    expect(mapPrStatusPill({ status: "Failed" })).toMatchObject({
      kind: "failed",
      label: "failed",
      tone: "red",
    });
  });
});

describe("buildLayoutCChips", () => {
  const base: LayoutCChipInput = {
    prStatus: "Completed",
    sizeTier: "small",
    rating: 7,
    mergeReady: false,
    mergeBlockReason: "rating_below_threshold",
    mergeMessage: "7/10 below merge bar (need 8+).",
    hasCheckout: true,
    lastFetchError: null,
    repoStatus: "ready",
    cloneUrl: "https://github.com/acme/app.git",
    provider: "github",
    webhookEnabled: true,
    webhookId: "1",
    indexedAt: "2026-07-01T00:00:00Z",
    runStatus: "completed",
    runOutcome: "reviewed",
    reliability: "complete",
    refused: false,
    stale: false,
    blockedGate: null,
  };

  it("returns status · size · webhook · cloned · indexed · rating · merge in order", () => {
    const chips = buildLayoutCChips(base);
    expect(chips.map((c) => c.id)).toEqual([
      "status",
      "size",
      "webhook",
      "cloned",
      "indexed",
      "rating",
      "merge",
    ]);
  });

  it("shows not ready amber when merge gate fails; detail only in tooltip", () => {
    const chips = buildLayoutCChips(base);
    const merge = chips.find((c) => c.id === "merge")!;
    expect(merge.label).toBe("not ready");
    expect(merge.tone).toBe("amber");
    expect(merge.title).toMatch(/7\/10|merge bar|not merge-ready/i);
  });

  it("shows merge ready green only when shared gate true", () => {
    const chips = buildLayoutCChips({
      ...base,
      rating: 9,
      mergeReady: true,
      mergeBlockReason: null,
      mergeMessage: null,
    });
    expect(chips.find((c) => c.id === "merge")).toMatchObject({
      label: "merge ready",
      tone: "green",
    });
    expect(chips.find((c) => c.id === "rating")).toMatchObject({
      label: "9/10",
      tone: "green",
    });
  });

  it("null rating is no score amber, not 0/10", () => {
    const chips = buildLayoutCChips({
      ...base,
      rating: null,
      mergeReady: false,
    });
    expect(chips.find((c) => c.id === "rating")).toMatchObject({
      label: "no score",
      tone: "amber",
    });
  });

  it("maps webhook installed+processing to on green; else off red", () => {
    const on = buildLayoutCChips(base).find((c) => c.id === "webhook")!;
    expect(on).toMatchObject({ label: "webhook on", tone: "green" });

    const idle = buildLayoutCChips({
      ...base,
      webhookEnabled: false,
      webhookId: "1",
    }).find((c) => c.id === "webhook")!;
    expect(idle).toMatchObject({ label: "webhook off", tone: "red" });

    const off = buildLayoutCChips({
      ...base,
      webhookEnabled: false,
      webhookId: null,
    }).find((c) => c.id === "webhook")!;
    expect(off).toMatchObject({ label: "webhook off", tone: "red" });
  });

  it("maps clone and index binary green/red labels", () => {
    const ok = buildLayoutCChips(base);
    expect(ok.find((c) => c.id === "cloned")).toMatchObject({ label: "cloned", tone: "green" });
    expect(ok.find((c) => c.id === "indexed")).toMatchObject({ label: "indexed", tone: "green" });

    const bad = buildLayoutCChips({
      ...base,
      lastFetchError: "auth failed",
      indexedAt: null,
    });
    expect(bad.find((c) => c.id === "cloned")).toMatchObject({
      label: "clone failed",
      tone: "red",
    });
    expect(bad.find((c) => c.id === "cloned")?.title).toMatch(/auth failed/);
    expect(bad.find((c) => c.id === "indexed")).toMatchObject({
      label: "index missing",
      tone: "red",
    });
  });

  it("labels missing checkout as not cloned (not clone failed)", () => {
    const chips = buildLayoutCChips({
      ...base,
      hasCheckout: false,
      lastFetchError: null,
      repoStatus: "ready",
      cloneUrl: "https://github.com/acme/app.git",
    });
    expect(chips.find((c) => c.id === "cloned")).toMatchObject({
      label: "not cloned",
      tone: "red",
    });
  });

  it("labels in-progress clone as cloning amber", () => {
    const chips = buildLayoutCChips({
      ...base,
      repoStatus: "cloning",
      lastFetchError: null,
    });
    expect(chips.find((c) => c.id === "cloned")).toMatchObject({
      label: "cloning",
      tone: "amber",
    });
  });

  it("surfaces blocked at {gate} as a single chip when blocked", () => {
    const chips = buildLayoutCChips({
      ...base,
      blockedGate: "clone",
      mergeMessage: "Blocked at clone",
    });
    const blocked = chips.find((c) => c.id === "blocked");
    expect(blocked).toMatchObject({
      label: "blocked at clone",
      tone: "amber",
    });
  });

  it("includes checks context in merge tooltip when run failed", () => {
    const chips = buildLayoutCChips({
      ...base,
      runStatus: "failed",
      mergeReady: false,
      checksFailed: true,
    });
    const merge = chips.find((c) => c.id === "merge")!;
    expect(merge.title.toLowerCase()).toMatch(/fail|check|not merge-ready/);
  });
});

describe("isCloneFailedForActions", () => {
  it("is true only for failed clone seam (not missing/warn)", () => {
    expect(
      isCloneFailedForActions({
        hasCheckout: true,
        lastFetchError: "auth failed",
        repoStatus: "error",
      }),
    ).toBe(true);
    expect(
      isCloneFailedForActions({
        hasCheckout: false,
        lastFetchError: null,
        repoStatus: "ready",
        cloneUrl: "https://github.com/acme/app.git",
      }),
    ).toBe(false);
    expect(
      isCloneFailedForActions({
        hasCheckout: true,
        lastFetchError: null,
        repoStatus: "ready",
      }),
    ).toBe(false);
  });
});

describe("buildSidebarPrRow", () => {
  it("shows PR # and issue # when known, plus status and rating pills", () => {
    const row = buildSidebarPrRow({
      title: "Promote endpoint",
      githubPrNumber: 30,
      sourceBranch: "ticket-24-promote",
      status: "Completed",
      rating: 6,
    });
    expect(row.title).toBe("Promote endpoint");
    expect(row.prNumberLabel).toBe("PR #30");
    expect(row.issueNumberLabel).toBe("issue #24");
    expect(row.status).toMatchObject({ label: "completed", tone: "green" });
    expect(row.rating).toMatchObject({ label: "6/10", tone: "amber" });
  });

  it("completed + low score stays completed green + amber rating", () => {
    const row = buildSidebarPrRow({
      title: "x",
      githubPrNumber: 1,
      sourceBranch: "x",
      status: "Completed",
      rating: 6,
    });
    expect(row.status.tone).toBe("green");
    expect(row.rating?.tone).toBe("amber");
  });

  it("shows no score when completed with null rating", () => {
    const row = buildSidebarPrRow({
      title: "x",
      githubPrNumber: null,
      sourceBranch: "y",
      status: "Completed",
      rating: null,
    });
    expect(row.prNumberLabel).toBeNull();
    expect(row.rating).toMatchObject({ label: "no score", tone: "amber" });
  });

  it("failed is red, not completed green", () => {
    const row = buildSidebarPrRow({
      title: "x",
      githubPrNumber: 2,
      sourceBranch: "z",
      status: "Failed",
      rating: 9,
    });
    expect(row.status).toMatchObject({ label: "failed", tone: "red" });
  });
});
