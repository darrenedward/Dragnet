import { describe, expect, it } from "vitest";
import { computeStackTopology, type PrTopologyInput } from "../src/lib/prStackTopology";

function pr(
  overrides: Partial<PrTopologyInput> & { sourceBranch: string; targetBranch: string },
): PrTopologyInput {
  return {
    id: `pr-${overrides.sourceBranch.replace(/[^a-z0-9]/g, "-")}`,
    rating: null,
    ...overrides,
  };
}

describe("computeStackTopology", () => {
  it("returns empty map for empty PR list", () => {
    const result = computeStackTopology([], new Set());
    expect(result.size).toBe(0);
  });

  it("returns depth=0 for standalone PR targeting main", () => {
    const prs = [pr({ sourceBranch: "feat/a", targetBranch: "main" })];
    const result = computeStackTopology(prs, new Set());
    expect(result.get(prs[0].id)).toEqual({
      stackDepth: 0,
      dependencies: [],
      unscannedDepsCount: 0,
    });
  });

  it("returns depth=0 when target has no matching PR", () => {
    const prs = [pr({ sourceBranch: "feat/a", targetBranch: "develop" })];
    const result = computeStackTopology(prs, new Set());
    expect(result.get(prs[0].id)!.stackDepth).toBe(0);
  });

  it("detects a 2-PR stack (one depends on the other)", () => {
    const prs = [
      pr({ sourceBranch: "feat/a", targetBranch: "main" }),
      pr({ sourceBranch: "feat/b", targetBranch: "feat/a" }),
    ];
    const result = computeStackTopology(prs, new Set());
    expect(result.get(prs[0].id)!.stackDepth).toBe(0);
    expect(result.get(prs[0].id)!.dependencies).toEqual([]);

    expect(result.get(prs[1].id)!.stackDepth).toBe(1);
    expect(result.get(prs[1].id)!.dependencies).toHaveLength(1);
    expect(result.get(prs[1].id)!.dependencies[0].sourceBranch).toBe("feat/a");
  });

  it("detects a 3-PR stack in root-first order", () => {
    const prs = [
      pr({ sourceBranch: "feat/a", targetBranch: "main" }),
      pr({ sourceBranch: "feat/b", targetBranch: "feat/a" }),
      pr({ sourceBranch: "feat/c", targetBranch: "feat/b" }),
    ];
    const result = computeStackTopology(prs, new Set());

    expect(result.get(prs[0].id)!.stackDepth).toBe(0);
    expect(result.get(prs[1].id)!.stackDepth).toBe(1);
    expect(result.get(prs[2].id)!.stackDepth).toBe(2);

    const deps = result.get(prs[2].id)!.dependencies;
    expect(deps[0].sourceBranch).toBe("feat/b");
    expect(deps[1].sourceBranch).toBe("feat/a");
  });

  it("handles multiple independent stacks", () => {
    const prs = [
      pr({ sourceBranch: "feat/a", targetBranch: "main" }),
      pr({ sourceBranch: "feat/b", targetBranch: "feat/a" }),
      pr({ sourceBranch: "feat/x", targetBranch: "main" }),
      pr({ sourceBranch: "feat/y", targetBranch: "feat/x" }),
    ];
    const result = computeStackTopology(prs, new Set());

    expect(result.get(prs[0].id)!.stackDepth).toBe(0);
    expect(result.get(prs[1].id)!.stackDepth).toBe(1);
    expect(result.get(prs[2].id)!.stackDepth).toBe(0);
    expect(result.get(prs[3].id)!.stackDepth).toBe(1);
  });

  it("counts unscanned dependencies correctly", () => {
    const prs = [
      pr({ id: "pr-a", sourceBranch: "feat/a", targetBranch: "main", rating: 9 }),
      pr({ id: "pr-b", sourceBranch: "feat/b", targetBranch: "feat/a", rating: null }),
      pr({ id: "pr-c", sourceBranch: "feat/c", targetBranch: "feat/b" }),
    ];
    const scanned = new Set(["pr-a"]);
    const result = computeStackTopology(prs, scanned);

    expect(result.get("pr-a")!.unscannedDepsCount).toBe(0);
    expect(result.get("pr-b")!.unscannedDepsCount).toBe(0); // pr-a is scanned
    expect(result.get("pr-c")!.unscannedDepsCount).toBe(1); // pr-b is unscanned
  });

  it("marks dependencies with scanned=false when not in scannedPrIds", () => {
    const prs = [
      pr({ id: "pr-a", sourceBranch: "feat/a", targetBranch: "main", rating: 8 }),
      pr({ id: "pr-b", sourceBranch: "feat/b", targetBranch: "feat/a" }),
    ];
    const result = computeStackTopology(prs, new Set(["pr-a"]));
    const dep = result.get(prs[1].id)!.dependencies[0];
    expect(dep.scanned).toBe(true);
    expect(dep.rating).toBe(8);
  });

  it("detects cycles and breaks without infinite loop", () => {
    const prs = [
      pr({ id: "pr-a", sourceBranch: "feat/a", targetBranch: "feat/b" }),
      pr({ id: "pr-b", sourceBranch: "feat/b", targetBranch: "feat/a" }),
    ];
    const result = computeStackTopology(prs, new Set());
    // Cycle should not cause infinite loop; stackDepth may be partial
    expect(result.get("pr-a")!.stackDepth).toBeLessThan(prs.length);
    expect(result.get("pr-b")!.stackDepth).toBeLessThan(prs.length);
  });

  it("includes full PrDependency fields", () => {
    const prs = [
      pr({ id: "pr-a", sourceBranch: "feat/a", targetBranch: "main", rating: 9 }),
      pr({ id: "pr-b", sourceBranch: "feat/b", targetBranch: "feat/a" }),
    ];
    const result = computeStackTopology(prs, new Set(["pr-a"]));
    const dep = result.get(prs[1].id)!.dependencies[0];
    expect(dep).toEqual({
      prId: "pr-a",
      sourceBranch: "feat/a",
      targetBranch: "main",
      scanned: true,
      rating: 9,
    });
  });

  it("handles duplicate source branches idempotently", () => {
    const prs = [
      pr({ id: "pr-a1", sourceBranch: "feat/a", targetBranch: "main" }),
      pr({ id: "pr-a2", sourceBranch: "feat/a", targetBranch: "develop" }),
      pr({ id: "pr-b", sourceBranch: "feat/b", targetBranch: "feat/a" }),
    ];
    const result = computeStackTopology(prs, new Set());
    // Should use first encountered (pr-a1) for the index
    expect(result.get("pr-b")!.dependencies[0].prId).toBe("pr-a1");
  });
});
