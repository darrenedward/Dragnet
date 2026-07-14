import { describe, it, expect } from "vitest";
import { diffBlockerFixes, type FindingShape } from "../src/services/findingLifecycle/diffFindings";

function blocker(filename: string, line: number | null, category: string) {
  return { filename, line, category, severity: "blocker" as const };
}

function warning(filename: string, line: number | null, category: string) {
  return { filename, line, category, severity: "warning" as const };
}

function suggestion(filename: string, line: number | null, category: string) {
  return { filename, line, category, severity: "suggestion" as const };
}

describe("diffBlockerFixes", () => {
  it("all match → empty", () => {
    const prior = [blocker("a.ts", 1, "security")];
    const current = [blocker("a.ts", 1, "security")];
    expect(diffBlockerFixes(prior, current)).toEqual([]);
  });

  it("blocker gone → returns it as fixed", () => {
    const prior = [blocker("a.ts", 1, "security")];
    const current: FindingShape[] = [];
    expect(diffBlockerFixes(prior, current)).toEqual([blocker("a.ts", 1, "security")]);
  });

  it("blocker present in both → not fixed", () => {
    const prior = [
      blocker("a.ts", 1, "security"),
      blocker("b.ts", 5, "performance"),
    ];
    const current = [
      blocker("a.ts", 1, "security"),
    ];
    expect(diffBlockerFixes(prior, current)).toEqual([
      blocker("b.ts", 5, "performance"),
    ]);
  });

  it("warning gone → ignored", () => {
    const prior = [warning("a.ts", 1, "style")];
    const current: FindingShape[] = [];
    expect(diffBlockerFixes(prior, current)).toEqual([]);
  });

  it("tuple mismatch (different category) → returns as fixed", () => {
    const prior = [blocker("a.ts", 1, "security")];
    const current = [blocker("a.ts", 1, "performance")];
    expect(diffBlockerFixes(prior, current)).toEqual([blocker("a.ts", 1, "security")]);
  });

  it("empty prior → empty result", () => {
    const prior: FindingShape[] = [];
    const current = [blocker("a.ts", 1, "security")];
    expect(diffBlockerFixes(prior, current)).toEqual([]);
  });

  it("empty current → all prior blockers returned", () => {
    const prior = [
      blocker("a.ts", 1, "security"),
      blocker("b.ts", 5, "performance"),
    ];
    const current: FindingShape[] = [];
    expect(diffBlockerFixes(prior, current)).toEqual(prior);
  });

  it("mix of blockers and warnings → only blockers in result", () => {
    const prior = [
      blocker("a.ts", 1, "security"),
      warning("a.ts", 2, "style"),
      suggestion("a.ts", 3, "nit"),
    ];
    const current: FindingShape[] = [];
    expect(diffBlockerFixes(prior, current)).toEqual([blocker("a.ts", 1, "security")]);
  });
});
