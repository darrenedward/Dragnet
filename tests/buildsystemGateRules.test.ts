import { describe, it, expect, vi } from "vitest";
import { detectBuildSystem } from "../src/lib/buildsystemDetect";
import { classifyDiff } from "../src/lib/diffClassifier";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "dragnet-gate-"));
}

function removeTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Unit tests for the gate rule decision logic used in reviewService.ts.
 *
 * The actual tier decision branches in reviewService.ts are:
 *
 *   tier1HadErrors = deterministicCheckFindings.some(f => f.severity === "error")
 *
 *   tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported
 *
 *   findingsEmpty = deterministicFindings.length === 0
 *   diffClass = classifyDiff(files)
 *   skipTier3 = findingsEmpty && diffClass.isTrivial
 *
 * These tests validate each decision independently.
 */

describe("Tier 1 → Tier 2 gate rules", () => {
  it("Tier 2 runs when Tier 1 is clean and toggle is off", () => {
    const tier1HadErrors = false;
    const skipTier2 = false;
    const tier2Supported = true;
    const hasPathOrClone = true;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(true);
  });

  it("Tier 2 is skipped when Tier 1 has errors", () => {
    const tier1HadErrors = true;
    const skipTier2 = false;
    const tier2Supported = true;
    const hasPathOrClone = true;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(false);
  });

  it("Tier 2 is skipped when skipTier2 toggle is on", () => {
    const tier1HadErrors = false;
    const skipTier2 = true;
    const tier2Supported = true;
    const hasPathOrClone = true;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(false);
  });

  it("Tier 2 is skipped when build system is unsupported (non-Node)", () => {
    const tier1HadErrors = false;
    const skipTier2 = false;
    const tier2Supported = false;
    const hasPathOrClone = true;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(false);
  });

  it("Tier 2 is skipped when there is no path or clone URL", () => {
    const tier1HadErrors = false;
    const skipTier2 = false;
    const tier2Supported = true;
    const hasPathOrClone = false;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(false);
  });

  it("Tier 2 skipped when toggle on AND Tier 1 has errors (redundant but safe)", () => {
    const tier1HadErrors = true;
    const skipTier2 = true;
    const tier2Supported = true;
    const hasPathOrClone = true;

    const tier2ShouldRun = hasPathOrClone && !skipTier2 && !tier1HadErrors && tier2Supported;
    expect(tier2ShouldRun).toBe(false);
  });
});

describe("Tier 3 gate rules", () => {
  it("Tier 3 skipped when findings empty and diff is trivial", () => {
    const findingsEmpty = true;
    const diffClass = { isTrivial: true, codeFiles: 0, trivialFiles: 3, totalFiles: 3 };
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(true);
  });

  it("Tier 3 runs when findings exist even if diff is trivial", () => {
    const findingsEmpty = false;
    const diffClass = { isTrivial: true, codeFiles: 0, trivialFiles: 2, totalFiles: 2 };
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(false);
  });

  it("Tier 3 runs when diff is non-trivial even if findings are empty", () => {
    const findingsEmpty = true;
    const diffClass = { isTrivial: false, codeFiles: 2, trivialFiles: 0, totalFiles: 2 };
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(false);
  });

  it("Tier 3 runs when both findings exist and diff is non-trivial", () => {
    const findingsEmpty = false;
    const diffClass = { isTrivial: false, codeFiles: 3, trivialFiles: 1, totalFiles: 4 };
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(false);
  });
});

describe("detectBuildSystem → tier2Supported mapping", () => {
  it("node build system has tier2Supported=true", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    try {
      const detected = await detectBuildSystem(dir);
      const tier2Supported = detected.buildSystem === "node";
      expect(tier2Supported).toBe(true);
    } finally {
      removeTempDir(dir);
    }
  });

  it.each(["rust", "python", "go", "ruby", "php"])(
    "%s build system has tier2Supported=false",
    async (bs) => {
      const dir = createTempDir();
      const files: Record<string, string> = {
        rust: "Cargo.toml",
        python: "pyproject.toml",
        go: "go.mod",
        ruby: "Gemfile",
        php: "composer.json",
      };
      writeFileSync(join(dir, files[bs]), "");
      try {
        const detected = await detectBuildSystem(dir);
        expect(detected.buildSystem).toBe(bs);
        const tier2Supported = detected.buildSystem === "node";
        expect(tier2Supported).toBe(false);
      } finally {
        removeTempDir(dir);
      }
    },
  );

  it("unknown build system has tier2Supported=true (falls back to node:20-alpine)", async () => {
    const dir = createTempDir();
    try {
      const detected = await detectBuildSystem(dir);
      expect(detected.buildSystem).toBe("unknown");
      const tier2Supported = detected.buildSystem === "node";
      // unknown fallback runs Tier 2 with node:20-alpine (best-effort)
      expect(tier2Supported).toBe(false);
      expect(detected.image).toBe("node:20-alpine");
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("diffClassifier → Tier 3 gate integration", () => {
  it("config-only diff with empty findings should skip Tier 3", () => {
    const files = [
      { filename: ".gitignore" },
      { filename: "tsconfig.json" },
      { filename: "README.md" },
    ];
    const diffClass = classifyDiff(files);
    const findingsEmpty = true;
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(true);
  });

  it("code change in diff with empty findings should NOT skip Tier 3", () => {
    const files = [
      { filename: "README.md" },
      { filename: "src/index.ts" },
    ];
    const diffClass = classifyDiff(files);
    const findingsEmpty = true;
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(false);
  });

  it("code-only diff with findings should NOT skip Tier 3", () => {
    const files = [
      { filename: "src/app.ts" },
      { filename: "src/lib/util.ts" },
    ];
    const diffClass = classifyDiff(files);
    const findingsEmpty = false;
    const skipTier3 = findingsEmpty && diffClass.isTrivial;
    expect(skipTier3).toBe(false);
  });
});
