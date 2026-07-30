import { describe, expect, it } from "vitest";
import {
  formatPrIdentity,
  ticketNumberFromBranch,
  type PrIdentityInput,
} from "../src/lib/prIdentity";

describe("ticketNumberFromBranch", () => {
  it("parses ticket-<n>-… at branch start", () => {
    expect(ticketNumberFromBranch("ticket-24-promote")).toBe(24);
  });

  it("parses ticket-<n> as a path segment", () => {
    expect(ticketNumberFromBranch("feat/ticket-146-correspondence")).toBe(146);
  });

  it("parses bare ticket-<n>", () => {
    expect(ticketNumberFromBranch("ticket-7")).toBe(7);
  });

  it("returns null when branch has no reliable ticket marker", () => {
    expect(ticketNumberFromBranch("feature/empty")).toBeNull();
    expect(ticketNumberFromBranch("test/dragnet-runner-smoke")).toBeNull();
    expect(ticketNumberFromBranch("main")).toBeNull();
    expect(ticketNumberFromBranch("")).toBeNull();
  });

  it("does not guess from unrelated numbers", () => {
    expect(ticketNumberFromBranch("pr-30-fix")).toBeNull();
    expect(ticketNumberFromBranch("issue-24-foo")).toBeNull();
    expect(ticketNumberFromBranch("myticket-24-x")).toBeNull();
    expect(ticketNumberFromBranch("24-promote")).toBeNull();
  });
});

describe("formatPrIdentity", () => {
  const base: PrIdentityInput = {
    title: "Promote endpoint: ambassadors",
    sourceBranch: "ticket-24-promote",
    githubPrNumber: 30,
    ticketNumber: 24,
  };

  it("returns two-line contract when PR # and ticket are known", () => {
    const id = formatPrIdentity(base);
    expect(id.prLine).toBe("GitHub PR: #30 — Promote endpoint: ambassadors");
    expect(id.issueLine).toBe("GitHub Issue: #24 — ticket-24-promote");
    expect(id.branchFallback).toBeNull();
  });

  it("PR only: issue line omitted, branch fallback only", () => {
    const id = formatPrIdentity({
      ...base,
      ticketNumber: null,
      sourceBranch: "feature/x",
    });
    expect(id.prLine).toBe("GitHub PR: #30 — Promote endpoint: ambassadors");
    expect(id.issueLine).toBeNull();
    expect(id.branchFallback).toBe("feature/x");
  });

  it("ticket only via branch: no PR number, issue line from ticketNumberFromBranch", () => {
    const ticket = ticketNumberFromBranch("ticket-24-promote");
    const id = formatPrIdentity({
      title: "Promote endpoint: ambassadors",
      sourceBranch: "ticket-24-promote",
      githubPrNumber: null,
      ticketNumber: ticket,
    });
    expect(ticket).toBe(24);
    expect(id.prLine).toBe("GitHub PR: — Promote endpoint: ambassadors");
    expect(id.issueLine).toBe("GitHub Issue: #24 — ticket-24-promote");
    expect(id.branchFallback).toBeNull();
  });

  it("neither: graceful PR line without number, branch fallback, no empty Issue line", () => {
    const id = formatPrIdentity({
      title: "Smoke test",
      sourceBranch: "test/dragnet-runner-smoke",
      githubPrNumber: null,
      ticketNumber: null,
    });
    expect(id.prLine).toBe("GitHub PR: — Smoke test");
    expect(id.issueLine).toBeNull();
    expect(id.branchFallback).toBe("test/dragnet-runner-smoke");
  });

  it("issue # ≠ PR # (both shown independently)", () => {
    const id = formatPrIdentity({
      title: "Admin PM user",
      sourceBranch: "ticket-25-admin-pm-user",
      githubPrNumber: 31,
      ticketNumber: 25,
    });
    expect(id.prLine).toBe("GitHub PR: #31 — Admin PM user");
    expect(id.issueLine).toBe("GitHub Issue: #25 — ticket-25-admin-pm-user");
    expect(id.prLine).not.toContain("#25");
    expect(id.issueLine).not.toContain("#31");
  });

  it("resolves ticket from sourceBranch when ticketNumber omitted", () => {
    const id = formatPrIdentity({
      title: "Search",
      sourceBranch: "ticket-23-search",
      githubPrNumber: 29,
    });
    expect(id.issueLine).toBe("GitHub Issue: #23 — ticket-23-search");
  });

  it("explicit null ticketNumber wins over branch parse (never invent)", () => {
    const id = formatPrIdentity({
      title: "Search",
      sourceBranch: "ticket-23-search",
      githubPrNumber: 29,
      ticketNumber: null,
    });
    expect(id.issueLine).toBeNull();
    expect(id.branchFallback).toBe("ticket-23-search");
  });
});
