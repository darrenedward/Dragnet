import { describe, expect, it } from "vitest";

import { applyTailSkip } from "../../src/services/largePrReview/orchestrator";
import { buildDiffManifest } from "../../src/services/largePrReview/manifest";
import type { ReviewFileInput } from "../../src/services/largePrReview/types";

function codeFile(name: string, additions: number): ReviewFileInput {
  return { filename: name, additions, deletions: 0 };
}

describe("applyTailSkip", () => {
  it("is a no-op when cap is 0 (off)", () => {
    const manifest = buildDiffManifest([
      codeFile("src/a.ts", 100),
      codeFile("src/b.ts", 200),
    ]);
    const result = applyTailSkip(manifest, 0);
    expect(result.skipped).toEqual([]);
    expect(result.manifest).toBe(manifest);
  });

  it("is a no-op when code file count <= cap", () => {
    const manifest = buildDiffManifest([
      codeFile("src/a.ts", 100),
      codeFile("src/b.ts", 200),
    ]);
    const result = applyTailSkip(manifest, 5);
    expect(result.skipped).toEqual([]);
    expect(result.manifest.codeFileCount).toBe(2);
  });

  it("keeps the largest N code files; drops the rest", () => {
    // 200 files of descending size: file-000 is biggest, file-199 smallest.
    const files: ReviewFileInput[] = Array.from({ length: 200 }, (_, i) =>
      codeFile(`src/file-${String(i).padStart(3, "0")}.ts`, 200 - i),
    );
    const manifest = buildDiffManifest(files);
    expect(manifest.codeFileCount).toBe(200);

    const result = applyTailSkip(manifest, 100);
    expect(result.skipped).toHaveLength(100);
    // The 100 kept files should be the largest: file-000..file-099.
    const keptNames = new Set(
      result.manifest.files.filter((f) => f.fileClass === "code").map((f) => f.filename),
    );
    expect(keptNames.has("src/file-000.ts")).toBe(true);
    expect(keptNames.has("src/file-099.ts")).toBe(true);
    expect(keptNames.has("src/file-100.ts")).toBe(false);
    expect(keptNames.has("src/file-199.ts")).toBe(false);
    // Skipped are the smaller 100.
    expect(result.skipped).toContain("src/file-199.ts");
    expect(result.skipped).toContain("src/file-100.ts");
    expect(result.skipped).not.toContain("src/file-099.ts");
  });

  it("re-derives codeLines + codeFileCount after the drop", () => {
    const manifest = buildDiffManifest([
      codeFile("src/big.ts", 500),
      codeFile("src/mid.ts", 300),
      codeFile("src/small.ts", 100),
    ]);
    const result = applyTailSkip(manifest, 2);
    expect(result.manifest.codeFileCount).toBe(2);
    expect(result.manifest.codeLines).toBe(800); // 500 + 300
    expect(result.skipped).toEqual(["src/small.ts"]);
  });

  it("preserves non-code files (docs/lockfiles) when dropping code", () => {
    const manifest = buildDiffManifest([
      codeFile("src/a.ts", 100),
      codeFile("src/b.ts", 200),
      { filename: "README.md", additions: 50, deletions: 0 },
      { filename: "package-lock.json", additions: 9999, deletions: 0 },
    ]);
    const result = applyTailSkip(manifest, 1);
    // Only 1 code file kept; the other code file is dropped. Docs/lock stay.
    expect(result.manifest.codeFileCount).toBe(1);
    expect(result.skipped).toHaveLength(1);
    const filenames = result.manifest.files.map((f) => f.filename);
    expect(filenames).toContain("README.md");
    expect(filenames).toContain("package-lock.json");
    // The biggest code file (b.ts) is kept; a.ts is dropped.
    expect(filenames).toContain("src/b.ts");
    expect(result.skipped).toContain("src/a.ts");
  });

  it("tie-breaks alphabetically when line counts are equal (deterministic)", () => {
    const manifest = buildDiffManifest([
      codeFile("src/zebra.ts", 100),
      codeFile("src/apple.ts", 100),
      codeFile("src/mango.ts", 100),
    ]);
    const result = applyTailSkip(manifest, 1);
    // All three have the same line count; the alphabetically-first is kept.
    expect(result.manifest.files.map((f) => f.filename)).toContain("src/apple.ts");
    expect(result.skipped).toContain("src/mango.ts");
    expect(result.skipped).toContain("src/zebra.ts");
  });
});
