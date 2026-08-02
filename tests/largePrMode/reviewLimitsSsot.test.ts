import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  effectiveChunkLineCap,
  type ReviewLimits,
} from "../../src/lib/prSizeConfig";
import { LIMIT_BOUNDS, validateLimits } from "../../src/lib/reviewLimitsValidation";
import { chunkDiff } from "../../src/services/largePrReview/chunker";
import { buildDiffManifest } from "../../src/services/largePrReview/manifest";
import {
  CHUNK_LINE_CAP,
  MIN_USEFUL_CHUNK_LINES,
} from "../../src/services/largePrReview/chunker";
import {
  NORMAL_MAX_CODE_FILES,
  NORMAL_MAX_LINES,
  OVERSIZED_CODE_FILES,
  OVERSIZED_LINES,
} from "../../src/services/largePrReview/manifest";
import { PR_SIZE_THRESHOLDS } from "../../src/lib/prSizeProfile";

function syntheticFiles(count: number, linesEach: number) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `src/mod${i}.ts`,
    additions: Math.ceil(linesEach / 2),
    deletions: Math.floor(linesEach / 2),
  }));
}

describe("ReviewLimits SSOT", () => {
  it("DEFAULT_LIMITS matches engine default constants (GET defaults payload parity)", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxConcurrentScans: 1,
      chunkLineCap: CHUNK_LINE_CAP,
      minUsefulChunkLines: MIN_USEFUL_CHUNK_LINES,
      normalMaxLines: NORMAL_MAX_LINES,
      normalMaxCodeFiles: NORMAL_MAX_CODE_FILES,
      oversizedLines: OVERSIZED_LINES,
      oversizedCodeFiles: OVERSIZED_CODE_FILES,
      maxFilesPerReview: 0,
    });
    expect(validateLimits(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
  });

  it("LIMIT_BOUNDS is the shared validation envelope", () => {
    expect(LIMIT_BOUNDS.maxConcurrentScans).toEqual({ min: 1, max: 32 });
    expect(LIMIT_BOUNDS.chunkLineCap.min).toBe(300);
  });

  it("raising normalMaxLines via limits yields fewer chunks for a synthetic manifest", () => {
    const files = syntheticFiles(6, 200); // ~1200 code lines
    const tight: ReviewLimits = {
      ...DEFAULT_LIMITS,
      chunkLineCap: 400,
      normalMaxLines: 400,
      minUsefulChunkLines: 50,
    };
    const loose: ReviewLimits = {
      ...DEFAULT_LIMITS,
      chunkLineCap: 400,
      normalMaxLines: 2000,
      minUsefulChunkLines: 50,
    };

    const tightManifest = buildDiffManifest(files as any, undefined, tight);
    const looseManifest = buildDiffManifest(files as any, undefined, loose);

    const tightPlans = chunkDiff(tightManifest, [], {
      chunkLineCap: effectiveChunkLineCap(tight),
      minUsefulChunkLines: tight.minUsefulChunkLines,
    });
    const loosePlans = chunkDiff(looseManifest, [], {
      chunkLineCap: effectiveChunkLineCap(loose),
      minUsefulChunkLines: loose.minUsefulChunkLines,
    });

    expect(loosePlans.length).toBeLessThan(tightPlans.length);
    expect(loosePlans.length).toBe(1);
    expect(tightPlans.length).toBeGreaterThan(1);
  });

  it("effectiveChunkLineCap is max(chunkLineCap, normalMaxLines)", () => {
    expect(effectiveChunkLineCap({ ...DEFAULT_LIMITS, chunkLineCap: 600, normalMaxLines: 800 })).toBe(800);
    expect(effectiveChunkLineCap({ ...DEFAULT_LIMITS, chunkLineCap: 1200, normalMaxLines: 800 })).toBe(1200);
  });

  it("documents prSizeProfile UI thresholds as intentional residual vs engine tiers", () => {
    // UI glance badges (prSizeProfile) ≠ engine normal/grouped/oversized (Review Limits).
    expect(PR_SIZE_THRESHOLDS.mediumCodeLines).toBe(500);
    expect(PR_SIZE_THRESHOLDS.oversizedCodeLines).toBe(DEFAULT_LIMITS.oversizedLines);
    expect(DEFAULT_LIMITS.normalMaxLines).not.toBe(PR_SIZE_THRESHOLDS.mediumCodeLines);
  });
});
