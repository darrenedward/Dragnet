import { describe, expect, it } from "vitest";
import {
  formatSidebarPrIdentityLine,
  layoutCCompactPillClassName,
  presentSidebarPrRow,
  shouldShowSidebarRatingPill,
} from "../src/lib/sidebarPrRow";

describe("formatSidebarPrIdentityLine", () => {
  it("shows PR # and issue # when both known and distinct", () => {
    expect(
      formatSidebarPrIdentityLine({
        title: "Admin PM user",
        sourceBranch: "ticket-25-admin-pm-user",
        githubPrNumber: 31,
        ticketNumber: 25,
      }),
    ).toBe("PR #31 · issue #25");
  });

  it("shows PR # only when issue unknown", () => {
    expect(
      formatSidebarPrIdentityLine({
        title: "Smoke",
        sourceBranch: "test/dragnet-runner-smoke",
        githubPrNumber: 80,
        ticketNumber: null,
      }),
    ).toBe("PR #80");
  });

  it("shows issue # only when PR number unknown (from branch ticket marker)", () => {
    expect(
      formatSidebarPrIdentityLine({
        title: "Promote",
        sourceBranch: "ticket-24-promote",
        githubPrNumber: null,
      }),
    ).toBe("issue #24");
  });

  it("returns null when neither PR nor issue is known", () => {
    expect(
      formatSidebarPrIdentityLine({
        title: "Local only",
        sourceBranch: "feature/x",
        githubPrNumber: null,
        ticketNumber: null,
      }),
    ).toBeNull();
  });

  it("never confuses PR # with issue #", () => {
    const line = formatSidebarPrIdentityLine({
      title: "Admin PM user",
      sourceBranch: "ticket-25-admin-pm-user",
      githubPrNumber: 31,
      ticketNumber: 25,
    });
    expect(line).toContain("PR #31");
    expect(line).toContain("issue #25");
    expect(line).not.toMatch(/PR #25/);
    expect(line).not.toMatch(/issue #31/);
  });
});

describe("shouldShowSidebarRatingPill", () => {
  it("shows on Completed even with null rating (no score)", () => {
    expect(shouldShowSidebarRatingPill("Completed", null)).toBe(true);
  });

  it("shows when a numeric rating exists on Pending", () => {
    expect(shouldShowSidebarRatingPill("Pending", 7)).toBe(true);
  });

  it("hides on Pending with no rating", () => {
    expect(shouldShowSidebarRatingPill("Pending", null)).toBe(false);
    expect(shouldShowSidebarRatingPill("Pending", undefined)).toBe(false);
  });

  it("shows on In Progress only when rated", () => {
    expect(shouldShowSidebarRatingPill("In Progress", null)).toBe(false);
    expect(shouldShowSidebarRatingPill("In Progress", 6)).toBe(true);
  });
});

describe("presentSidebarPrRow", () => {
  it("assembles title, identity line, status + rating pills with tones", () => {
    const row = presentSidebarPrRow({
      title: "Admin PM user",
      sourceBranch: "ticket-25-admin-pm-user",
      githubPrNumber: 31,
      ticketNumber: 25,
      status: "Completed",
      rating: 9,
    });
    expect(row.title).toBe("Admin PM user");
    expect(row.identityLine).toBe("PR #31 · issue #25");
    expect(row.status.kind).toBe("completed");
    expect(row.status.tone).toBe("green");
    expect(row.status.label).toBe("completed");
    expect(row.showRating).toBe(true);
    expect(row.rating?.label).toBe("9/10");
    expect(row.rating?.tone).toBe("green");
  });

  it("pending → amber status; no rating pill without score", () => {
    const row = presentSidebarPrRow({
      title: "WIP",
      sourceBranch: "feature/wip",
      githubPrNumber: 42,
      ticketNumber: null,
      status: "Pending",
      rating: null,
    });
    expect(row.identityLine).toBe("PR #42");
    expect(row.status.kind).toBe("pending");
    expect(row.status.tone).toBe("amber");
    expect(row.showRating).toBe(false);
    expect(row.rating).toBeNull();
  });

  it("processing → blue status pill", () => {
    const row = presentSidebarPrRow({
      title: "Scan me",
      sourceBranch: "ticket-10-x",
      githubPrNumber: 10,
      status: "In Progress",
      queuePosition: 2,
      rating: null,
    });
    expect(row.status.kind).toBe("processing");
    expect(row.status.tone).toBe("blue");
    expect(row.status.label).toBe("processing #2");
  });

  it("completed with null rating still exposes no-score amber rating pill", () => {
    const row = presentSidebarPrRow({
      title: "Smoke",
      sourceBranch: "test/smoke",
      githubPrNumber: 80,
      status: "Completed",
      rating: null,
    });
    expect(row.showRating).toBe(true);
    expect(row.rating?.label).toBe("no score");
    expect(row.rating?.tone).toBe("amber");
  });

  it("rating bands: 1–4 red · 5–7 amber · 8–10 green", () => {
    expect(presentSidebarPrRow({ title: "a", sourceBranch: "b", status: "Completed", rating: 3 }).rating?.tone).toBe("red");
    expect(presentSidebarPrRow({ title: "a", sourceBranch: "b", status: "Completed", rating: 6 }).rating?.tone).toBe("amber");
    expect(presentSidebarPrRow({ title: "a", sourceBranch: "b", status: "Completed", rating: 8 }).rating?.tone).toBe("green");
  });
});

describe("layoutCCompactPillClassName", () => {
  it("returns colored oblong classes (not plain grey text)", () => {
    for (const tone of ["amber", "blue", "green", "red"] as const) {
      const cls = layoutCCompactPillClassName(tone);
      expect(cls).toMatch(/rounded-full/);
      expect(cls).toMatch(/border/);
      expect(cls).not.toMatch(/cursor-help/);
      expect(cls).toMatch(/text-\[8px\]/);
    }
    expect(layoutCCompactPillClassName("amber")).toMatch(/amber/);
    expect(layoutCCompactPillClassName("blue")).toMatch(/sky/);
    expect(layoutCCompactPillClassName("green")).toMatch(/emerald/);
    expect(layoutCCompactPillClassName("red")).toMatch(/rose/);
  });
});
