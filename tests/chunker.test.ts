import { describe, it, expect } from "vitest";
import {
  chunkDiff,
  verifyChunkPlan,
  CHUNK_LINE_CAP,
  MIN_USEFUL_CHUNK_LINES,
} from "../src/services/largePrReview/chunker";
import { buildDiffManifest } from "../src/services/largePrReview/manifest";
import type { ReviewFileInput } from "../src/services/largePrReview/types";

/**
 * Chunker tests — sort + greedy fill + verifier.
 *
 * The core invariant: tiny files fold into chunks with their package
 * mates, not their own singleton chunks. Driven by a real-world
 * failure mode where .env.example (3 lines), package.json (7 lines),
 * prisma/schema.prisma (149), and a tests file (35) each got their
 * own chunk and burned a full 16-iteration LLM scan on near-empty input.
 */

function file(filename: string, additions: number, deletions = 0): ReviewFileInput {
  return { filename, additions, deletions };
}

function manifestOf(files: ReviewFileInput[]) {
  return buildDiffManifest(files);
}

describe("chunker — sort + greedy fill", () => {
  it("folds tiny singleton-bucket files into real-code chunks", () => {
    // Reproduces the skills-bulk failure mode: 4 tiny files in unique
    // buckets + several real-code files. Previous bucketing produced
    // 9 chunks; greedy fill should produce ~5-6 with NO tiny singletons
    // except possibly the last.
    const files: ReviewFileInput[] = [
      file(".env.example", 3),
      file("package.json", 7),
      file("prisma/schema.prisma", 149),
      file("tests/skills-security-scan.test.ts", 35),
      file("src/app/api/skills/route.ts", 64),
      file("src/app/api/skills/import-pack/route.ts", 39),
      file("src/lib/skills/manifest-parser.ts", 78),
      file("src/lib/skills/marketplace.ts", 138),
      file("src/lib/skills/github-client.ts", 207),
      file("src/services/skills/import-service.ts", 320),
      file("src/services/skills/security-scan.ts", 138),
      file("src/services/skills/version-service.ts", 162),
    ];
    const manifest = manifestOf(files);
    const plans = chunkDiff(manifest);

    // Verify invariants — should be zero issues.
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    const issues = verifyChunkPlan(plans, codeFiles);
    expect(issues).toEqual([]);

    // Every file must appear in exactly one chunk (conservation).
    const allPaths = plans.flatMap((p) => p.filePaths).sort();
    const expectedPaths = codeFiles.map((f) => f.filename).sort();
    expect(allPaths).toEqual(expectedPaths);

    // No tiny singleton chunks for .env.example, package.json, etc.
    const singletonBuckets = new Set([".env.example", "package.json", "prisma/schema.prisma"]);
    for (const plan of plans) {
      if (plan.files.length === 1) {
        const f = plan.files[0].filename;
        if (singletonBuckets.has(f)) {
          throw new Error(`${f} got its own singleton chunk — greedy fill should have folded it`);
        }
      }
    }

    // Sanity: should produce fewer chunks than the old bucketing did (9).
    expect(plans.length).toBeLessThanOrEqual(7);
  });

  it("preserves locality — files in the same package land in the same chunk when they fit", () => {
    const files: ReviewFileInput[] = [
      file("src/lib/skills/foo.ts", 200),
      file("src/lib/skills/bar.ts", 200),
      file("src/lib/skills/baz.ts", 200),
    ];
    const plans = chunkDiff(manifestOf(files));
    expect(plans.length).toBe(1);
    expect(plans[0].files.length).toBe(3);
    expect(plans[0].lineCount).toBe(600);
  });

  it("splits when same-package files exceed the cap", () => {
    // 4 files × 200 = 800 lines — exceeds 600 cap, must split.
    const files: ReviewFileInput[] = [
      file("src/lib/skills/a.ts", 200),
      file("src/lib/skills/b.ts", 200),
      file("src/lib/skills/c.ts", 200),
      file("src/lib/skills/d.ts", 200),
    ];
    const plans = chunkDiff(manifestOf(files));
    expect(plans.length).toBe(2);
    // First chunk fills to cap, second takes remainder.
    expect(plans[0].lineCount).toBe(600);
    expect(plans[1].lineCount).toBe(200);
    // Last chunk is allowed to be small — that's the remainder, not waste.
    const issues = verifyChunkPlan(
      plans,
      manifestOf(files).files.filter((f) => f.fileClass === "code"),
    );
    expect(issues).toEqual([]);
  });

  it("gives an oversized single file its own chunk", () => {
    // A 1000-line file exceeds the 600 cap. It must get its own chunk;
    // the verifier allows this exception.
    const files: ReviewFileInput[] = [
      file("src/lib/huge.ts", 1000),
      file("src/lib/small.ts", 50),
    ];
    const plans = chunkDiff(manifestOf(files));
    expect(plans.length).toBe(2);
    // The huge file should be its own chunk.
    const hugeChunk = plans.find((p) => p.files.some((f) => f.filename === "src/lib/huge.ts"));
    expect(hugeChunk?.files.length).toBe(1);
    expect(hugeChunk?.lineCount).toBe(1000);
    // small.ts goes in its own chunk because the huge one is full.
    const smallChunk = plans.find((p) => p.files.some((f) => f.filename === "src/lib/small.ts"));
    expect(smallChunk).toBeDefined();
    // Verifier allows: oversized-single-file + last-chunk-remainder.
    const issues = verifyChunkPlan(
      plans,
      manifestOf(files).files.filter((f) => f.fileClass === "code"),
    );
    expect(issues).toEqual([]);
  });

  it("returns an empty plan for an empty manifest", () => {
    const plans = chunkDiff(manifestOf([]));
    expect(plans).toEqual([]);
  });

  it("skips non-code files (docs, lockfiles, generated)", () => {
    // package.json IS treated as code today (legacy — see manifest.ts).
    // docs/README.md is documentation; package-lock.json is a lockfile.
    // Both should be excluded from chunks.
    const files: ReviewFileInput[] = [
      file("docs/README.md", 100),
      file("package-lock.json", 5000),
      file("src/lib/real.ts", 100),
    ];
    const plans = chunkDiff(manifestOf(files));
    const allPaths = plans.flatMap((p) => p.filePaths);
    expect(allPaths).not.toContain("docs/README.md");
    expect(allPaths).not.toContain("package-lock.json");
    expect(allPaths).toContain("src/lib/real.ts");
  });

  it("labels chunks deterministically", () => {
    // Same input must produce same chunk IDs + labels every time.
    const files: ReviewFileInput[] = [
      file("src/lib/a.ts", 100),
      file("src/lib/b.ts", 100),
    ];
    const run1 = chunkDiff(manifestOf(files));
    const run2 = chunkDiff(manifestOf(files));
    expect(run1.map((p) => p.id)).toEqual(run2.map((p) => p.id));
    expect(run1.map((p) => p.label)).toEqual(run2.map((p) => p.label));
  });
});

describe("verifyChunkPlan — invariant enforcement", () => {
  it("flags dropped files", () => {
    const files: ReviewFileInput[] = [
      file("src/lib/a.ts", 100),
      file("src/lib/b.ts", 100),
    ];
    const manifest = manifestOf(files);
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    // Build a plan that drops b.ts.
    const incompletePlan = [{
      id: "chunk-001",
      label: "src/lib/a.ts",
      files: [codeFiles[0]],
      filePaths: ["src/lib/a.ts"],
      lineCount: 100,
      touchesSecuritySensitive: false,
    }];
    const issues = verifyChunkPlan(incompletePlan, codeFiles);
    expect(issues.some((i) => i.includes("dropped"))).toBe(true);
  });

  it("flags duplicated files", () => {
    const files: ReviewFileInput[] = [file("src/lib/a.ts", 100)];
    const manifest = manifestOf(files);
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    const dupPlan = [
      {
        id: "chunk-001", label: "a", files: [codeFiles[0]], filePaths: ["src/lib/a.ts"],
        lineCount: 100, touchesSecuritySensitive: false,
      },
      {
        id: "chunk-002", label: "a", files: [codeFiles[0]], filePaths: ["src/lib/a.ts"],
        lineCount: 100, touchesSecuritySensitive: false,
      },
    ];
    const issues = verifyChunkPlan(dupPlan, codeFiles);
    expect(issues.some((i) => i.includes("duplicated"))).toBe(true);
  });

  it("flags chunks that exceed the cap without being single-oversized", () => {
    // Two files in one chunk totaling over the cap — should have been split.
    const files: ReviewFileInput[] = [
      file("src/lib/a.ts", 400),
      file("src/lib/b.ts", 400),
    ];
    const manifest = manifestOf(files);
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    const overCapPlan = [{
      id: "chunk-001",
      label: "src/lib/ts-js",
      files: codeFiles,
      filePaths: codeFiles.map((f) => f.filename),
      lineCount: 800,
      touchesSecuritySensitive: false,
    }];
    const issues = verifyChunkPlan(overCapPlan, codeFiles);
    expect(issues.some((i) => i.includes("exceeds cap"))).toBe(true);
  });

  it("flags wastefully-small chunks in the middle of a plan", () => {
    // A 30-line chunk with chunks after it = waste. Greedy fill should
    // have folded it into the next chunk.
    const files: ReviewFileInput[] = [
      file("src/lib/a.ts", 30),
      file("src/lib/b.ts", 30),
      file("src/lib/c.ts", 30),
    ];
    const manifest = manifestOf(files);
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    const wastefulPlan = [
      {
        id: "chunk-001", label: "a", files: [codeFiles[0]], filePaths: [codeFiles[0].filename],
        lineCount: 30, touchesSecuritySensitive: false,
      },
      {
        id: "chunk-002", label: "rest", files: [codeFiles[1], codeFiles[2]],
        filePaths: [codeFiles[1].filename, codeFiles[2].filename],
        lineCount: 60, touchesSecuritySensitive: false,
      },
    ];
    const issues = verifyChunkPlan(wastefulPlan, codeFiles);
    expect(issues.some((i) => i.includes("wastefully small"))).toBe(true);
  });

  it("allows the last chunk to be smaller than MIN_USEFUL", () => {
    // First chunk is healthy (>= MIN_USEFUL), last is the small remainder.
    // Verifier should NOT flag either — the last is exempt, the first is fine.
    const files: ReviewFileInput[] = [
      file("src/lib/a.ts", 120),
      file("src/lib/b.ts", 120),
      file("src/lib/c.ts", 30),
    ];
    const manifest = manifestOf(files);
    const codeFiles = manifest.files.filter((f) => f.fileClass === "code");
    const lastSmallPlan = [
      {
        id: "chunk-001", label: "rest", files: [codeFiles[0], codeFiles[1]],
        filePaths: [codeFiles[0].filename, codeFiles[1].filename],
        lineCount: 240, touchesSecuritySensitive: false,
      },
      {
        id: "chunk-002", label: "c", files: [codeFiles[2]], filePaths: [codeFiles[2].filename],
        lineCount: 30, touchesSecuritySensitive: false,
      },
    ];
    const issues = verifyChunkPlan(lastSmallPlan, codeFiles);
    // Last chunk being small is allowed; no other invariants violated.
    expect(issues).toEqual([]);
  });
});

// Reference the constants so unused-import lint doesn't fire if tests
// above don't directly use them — also documents the values.
describe("chunker constants", () => {
  it("CHUNK_LINE_CAP is 600", () => expect(CHUNK_LINE_CAP).toBe(600));
  it("MIN_USEFUL_CHUNK_LINES is 100", () => expect(MIN_USEFUL_CHUNK_LINES).toBe(100));
});
