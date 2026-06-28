import { describe, expect, it } from "vitest";
import { buildDiffManifest, chunkDiff, verifyChunkPlan } from "../../src/services/largePrReview";

describe("largePrReview chunker", () => {
  it("chunks deterministically and conserves every file", () => {
    const manifest = buildDiffManifest([
      { filename: "packages/api/src/a.ts", additions: 300, deletions: 0 },
      { filename: "packages/web/src/a.tsx", additions: 300, deletions: 0 },
      { filename: "packages/api/src/b.ts", additions: 250, deletions: 0 },
      { filename: "packages/api/src/c.css", additions: 200, deletions: 0 },
    ]);

    const first = chunkDiff(manifest);
    const second = chunkDiff(buildDiffManifest([...manifest.files].reverse()));

    // Determinism: input order must not change the plan.
    expect(first.map((chunk) => chunk.filePaths)).toEqual(second.map((chunk) => chunk.filePaths));
    expect(first.map((chunk) => chunk.label)).toEqual(second.map((chunk) => chunk.label));

    // Conservation: every code file appears in exactly one chunk.
    const expected = manifest.files.filter((f) => f.fileClass === "code").map((f) => f.filename).sort();
    const actual = first.flatMap((chunk) => chunk.filePaths).sort();
    expect(actual).toEqual(expected);

    // Invariants: cap enforced, no waste.
    expect(verifyChunkPlan(first, manifest.files.filter((f) => f.fileClass === "code"))).toEqual([]);
  });

  it("keeps chunks under 600 lines unless a single file is larger", () => {
    const manifest = buildDiffManifest([
      { filename: "src/a.ts", additions: 300, deletions: 0 },
      { filename: "src/b.ts", additions: 250, deletions: 0 },
      { filename: "src/c.ts", additions: 250, deletions: 0 },
      { filename: "src/huge.ts", additions: 900, deletions: 0 },
    ]);

    const chunks = chunkDiff(manifest);
    expect(chunks.map((chunk) => chunk.lineCount)).toEqual([550, 250, 900]);
  });

  it("marks security-sensitive chunks", () => {
    const manifest = buildDiffManifest([
      { filename: "src/app/api/auth/route.ts", additions: 100, deletions: 0 },
      { filename: "src/components/Button.tsx", additions: 100, deletions: 0 },
    ]);

    const chunks = chunkDiff(manifest);
    const authChunk = chunks.find((chunk) => chunk.filePaths.includes("src/app/api/auth/route.ts"));
    expect(authChunk?.touchesSecuritySensitive).toBe(true);
  });
});
