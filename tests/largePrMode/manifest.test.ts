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
});
