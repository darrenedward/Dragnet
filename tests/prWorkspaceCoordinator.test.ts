import { describe, expect, it } from "vitest";
import { PrWorkspaceCoordinator } from "../src/lib/prWorkspaceCoordinator";

describe("PrWorkspaceCoordinator", () => {
  it("rejects a late PR list response after the repository changes", () => {
    const coordinator = new PrWorkspaceCoordinator();
    const first = coordinator.beginPrList("repo-a");
    const second = coordinator.beginPrList("repo-b");

    expect(coordinator.isCurrentPrList(first)).toBe(false);
    expect(coordinator.isCurrentPrList(second)).toBe(true);
  });

  it("rejects stale details after the selected PR changes", () => {
    const coordinator = new PrWorkspaceCoordinator();
    const first = coordinator.beginDetails("pr-a");
    const second = coordinator.beginDetails("pr-b");

    expect(coordinator.isCurrentDetails(first)).toBe(false);
    expect(coordinator.isCurrentDetails(second)).toBe(true);
  });

  it("keeps the selected PR when a refreshed list still contains it", () => {
    const coordinator = new PrWorkspaceCoordinator();

    expect(coordinator.selectPr("pr-a", ["pr-a", "pr-b"])).toBe("pr-a");
    expect(coordinator.reconcilePrSelection("pr-a", ["pr-a", "pr-b"])).toBe("pr-a");
    expect(coordinator.reconcilePrSelection("pr-a", ["pr-b"])).toBe("pr-b");
  });

  it("clears selection when a refreshed list is empty", () => {
    const coordinator = new PrWorkspaceCoordinator();

    expect(coordinator.reconcilePrSelection("pr-a", [])).toBe("");
  });
});
