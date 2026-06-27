import { describe, expect, it } from "vitest";
import { computePrSizeProfile, isProfiledCodeFile } from "../src/lib/prSizeProfile";

describe("prSizeProfile", () => {
  it("counts code lines while excluding docs, lockfiles, and generated output", () => {
    const profile = computePrSizeProfile([
      { filename: "src/app.ts", additions: 120, deletions: 30 },
      { filename: "docs/usage.md", additions: 1000, deletions: 100 },
      { filename: "package-lock.json", additions: 5000, deletions: 0 },
      { filename: "src/generated/client.ts", additions: 800, deletions: 10 },
    ], 3);

    expect(profile.codeLines).toBe(150);
    expect(profile.codeFiles).toBe(1);
    expect(profile.totalFiles).toBe(4);
    expect(profile.additions).toBe(6920);
    expect(profile.deletions).toBe(140);
    expect(profile.tier).toBe("small");
  });

  it("uses line thresholds for medium, large, and oversized tiers", () => {
    expect(computePrSizeProfile([{ filename: "src/a.ts", additions: 499, deletions: 0 }]).tier)
      .toBe("small");
    expect(computePrSizeProfile([{ filename: "src/a.ts", additions: 500, deletions: 0 }]).tier)
      .toBe("medium");
    expect(computePrSizeProfile([{ filename: "src/a.ts", additions: 1500, deletions: 0 }]).tier)
      .toBe("large");
    expect(computePrSizeProfile([{ filename: "src/a.ts", additions: 3001, deletions: 0 }]).tier)
      .toBe("oversized");
  });

  it("uses commit thresholds when commit count is available", () => {
    expect(computePrSizeProfile([], 14).tier).toBe("small");
    expect(computePrSizeProfile([], 15).tier).toBe("medium");
    expect(computePrSizeProfile([], 40).tier).toBe("large");
    expect(computePrSizeProfile([], 101).tier).toBe("oversized");
  });

  it("classifies common non-code paths consistently", () => {
    expect(isProfiledCodeFile("README.md")).toBe(false);
    expect(isProfiledCodeFile("yarn.lock")).toBe(false);
    expect(isProfiledCodeFile("dist/index.js")).toBe(false);
    expect(isProfiledCodeFile("src/components/Button.tsx")).toBe(true);
  });
});
