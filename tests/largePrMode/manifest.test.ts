import { describe, expect, it } from "vitest";
import { assertTier, buildDiffManifest, classifyPath } from "../../src/services/largePrReview";

describe("largePrReview manifest", () => {
  it("classifies docs, lockfiles, generated files, vendor, and code", () => {
    expect(classifyPath("README.md")).toBe("docs");
    expect(classifyPath(".agent-os/specs/plan.md")).toBe("docs");
    expect(classifyPath("package-lock.json")).toBe("lock");
    expect(classifyPath("dist/app.js")).toBe("generated");
    expect(classifyPath("vendor/foo.ts")).toBe("vendor");
    expect(classifyPath("src/app.ts")).toBe("code");
  });

  it("routes normal, grouped, and oversized by code lines", () => {
    expect(assertTier(buildDiffManifest([{ filename: "src/a.ts", additions: 800, deletions: 0 }])).tier)
      .toBe("normal");
    expect(assertTier(buildDiffManifest([{ filename: "src/a.ts", additions: 801, deletions: 0 }])).tier)
      .toBe("grouped");
    expect(assertTier(buildDiffManifest([{ filename: "src/a.ts", additions: 3001, deletions: 0 }])).tier)
      .toBe("oversized");
  });

  it("excludes dependency lockfile lines from code-tier routing", () => {
    const manifest = buildDiffManifest([
      { filename: "package-lock.json", additions: 5000, deletions: 0 },
    ]);

    expect(manifest.codeLines).toBe(0);
    expect(manifest.lockFileCount).toBe(1);
    expect(manifest.tier).toBe("normal");
  });

  it("honors TierThresholds overrides from .dragnet/review-limits.json", () => {
    // 3500-line PR is "oversized" under defaults (>3000), but "grouped"
    // when the user has bumped oversizedLines to 5000.
    const files = [{ filename: "src/a.ts", additions: 3500, deletions: 0 }];
    expect(buildDiffManifest(files).tier).toBe("oversized");
    expect(
      buildDiffManifest(files, undefined, {
        normalMaxLines: 800,
        oversizedLines: 5000,
      }).tier,
    ).toBe("grouped");
    // Same input is "normal" if the user bumped normalMaxLines above it.
    expect(
      buildDiffManifest(files, undefined, {
        normalMaxLines: 4000,
        oversizedLines: 5000,
      }).tier,
    ).toBe("normal");
  });

  it("honors file-count overrides", () => {
    // 60 code files: oversized by default file cap (100) is not exceeded,
    // but normal (40) is — tier is grouped. Under a custom oversized=50,
    // it tips to oversized.
    const files = Array.from({ length: 60 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      additions: 5,
      deletions: 0,
    }));
    expect(buildDiffManifest(files).tier).toBe("grouped");
    expect(
      buildDiffManifest(files, undefined, {
        normalMaxCodeFiles: 40,
        oversizedCodeFiles: 50,
      }).tier,
    ).toBe("oversized");
  });
});
