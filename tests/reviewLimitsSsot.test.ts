import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LIMITS,
  clearLimitsCache,
  effectiveChunkLineCap,
  chunkOptionsFromLimits,
  readLimits,
  saveLimits,
  tierThresholdsFromLimits,
} from "../src/lib/prSizeConfig";
import {
  CHUNK_LINE_CAP,
  MIN_USEFUL_CHUNK_LINES,
  chunkDiff,
} from "../src/services/largePrReview/chunker";
import {
  NORMAL_MAX_CODE_FILES,
  NORMAL_MAX_LINES,
  OVERSIZED_CODE_FILES,
  OVERSIZED_LINES,
  buildDiffManifest,
  assertTier,
} from "../src/services/largePrReview/manifest";
import type { ReviewFileInput } from "../src/services/largePrReview/types";

/**
 * Review Limits SSOT residual (#149):
 * - defaults payload matches engine constants
 * - hardcodes are defaults only; live tier/chunk plan reads saved limits
 */
describe("Review Limits SSOT", () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "dragnet-ssot-"));
    process.chdir(tempRoot);
    clearLimitsCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    clearLimitsCache();
  });

  describe("defaults payload parity with engine constants", () => {
    it("DEFAULT_LIMITS matches chunker + manifest shipped constants", () => {
      expect(DEFAULT_LIMITS.chunkLineCap).toBe(CHUNK_LINE_CAP);
      expect(DEFAULT_LIMITS.minUsefulChunkLines).toBe(MIN_USEFUL_CHUNK_LINES);
      expect(DEFAULT_LIMITS.normalMaxLines).toBe(NORMAL_MAX_LINES);
      expect(DEFAULT_LIMITS.normalMaxCodeFiles).toBe(NORMAL_MAX_CODE_FILES);
      expect(DEFAULT_LIMITS.oversizedLines).toBe(OVERSIZED_LINES);
      expect(DEFAULT_LIMITS.oversizedCodeFiles).toBe(OVERSIZED_CODE_FILES);
    });

    it("shipped defaults are the documented 800/40/3000/100 tier envelope", () => {
      expect(DEFAULT_LIMITS.normalMaxLines).toBe(800);
      expect(DEFAULT_LIMITS.normalMaxCodeFiles).toBe(40);
      expect(DEFAULT_LIMITS.oversizedLines).toBe(3000);
      expect(DEFAULT_LIMITS.oversizedCodeFiles).toBe(100);
    });

    it("GET defaults shape equals DEFAULT_LIMITS (route payload contract)", () => {
      // Mirrors route.ts: { ok, limits, defaults: DEFAULT_LIMITS }
      const payload = { ok: true, limits: readLimits(), defaults: DEFAULT_LIMITS };
      expect(payload.defaults).toEqual(DEFAULT_LIMITS);
      expect(payload.limits).toEqual(DEFAULT_LIMITS);
    });
  });

  describe("saving limits changes tier/chunk plan (synthetic)", () => {
    const syntheticFiles: ReviewFileInput[] = [
      { filename: "src/a.ts", additions: 900, deletions: 0 },
      { filename: "src/b.ts", additions: 900, deletions: 0 },
    ];

    it("default limits: 1800 lines is grouped; effective chunk cap is max(chunk, normal)", () => {
      const limits = readLimits();
      expect(limits).toEqual(DEFAULT_LIMITS);

      const thresholds = tierThresholdsFromLimits(limits);
      const manifest = buildDiffManifest(syntheticFiles, undefined, thresholds);
      expect(assertTier(manifest, thresholds).tier).toBe("grouped");

      const cap = effectiveChunkLineCap(limits);
      expect(cap).toBe(Math.max(DEFAULT_LIMITS.chunkLineCap, DEFAULT_LIMITS.normalMaxLines));
      expect(cap).toBe(800);

      const plans = chunkDiff(manifest, [], chunkOptionsFromLimits(limits));
      // 1800 lines / 800 cap → at least 2 chunks
      expect(plans.length).toBeGreaterThanOrEqual(2);
      for (const plan of plans) {
        if (plan.files.length > 1) {
          expect(plan.lineCount).toBeLessThanOrEqual(cap);
        }
      }
    });

    it("after saveLimits with higher normalMaxLines, same PR becomes normal and single-chunk", async () => {
      await saveLimits({
        ...DEFAULT_LIMITS,
        normalMaxLines: 2000,
        chunkLineCap: 600,
      });
      clearLimitsCache();

      const limits = readLimits();
      expect(limits.normalMaxLines).toBe(2000);

      const thresholds = tierThresholdsFromLimits(limits);
      const manifest = buildDiffManifest(syntheticFiles, undefined, thresholds);
      expect(assertTier(manifest, thresholds).tier).toBe("normal");

      const cap = effectiveChunkLineCap(limits);
      expect(cap).toBe(2000); // max(600, 2000)

      const plans = chunkDiff(manifest, [], chunkOptionsFromLimits(limits));
      expect(plans).toHaveLength(1);
      expect(plans[0].lineCount).toBe(1800);
    });

    it("after saveLimits with lower oversizedLines, same PR becomes oversized", async () => {
      await saveLimits({
        ...DEFAULT_LIMITS,
        normalMaxLines: 500,
        oversizedLines: 1000,
      });
      clearLimitsCache();

      const limits = readLimits();
      const thresholds = tierThresholdsFromLimits(limits);
      const manifest = buildDiffManifest(syntheticFiles, undefined, thresholds);
      expect(assertTier(manifest, thresholds).tier).toBe("oversized");
    });

    it("live path must not fall back to bare constants when thresholds omitted after custom save", async () => {
      // Regression: assertTier(manifest) without thresholds ignored saved limits.
      await saveLimits({
        ...DEFAULT_LIMITS,
        normalMaxLines: 2000,
        oversizedLines: 5000,
      });
      clearLimitsCache();
      const limits = readLimits();
      const thresholds = tierThresholdsFromLimits(limits);
      const manifest = buildDiffManifest(syntheticFiles, undefined, thresholds);
      // With thresholds: normal. Without: hardcoded 800 → grouped (bypass).
      expect(assertTier(manifest, thresholds).tier).toBe("normal");
      expect(assertTier(manifest).tier).toBe("grouped"); // bare constant fallback
      // Policy helpers always carry the live limits — call sites must use them.
      expect(tierThresholdsFromLimits(limits).normalMaxLines).toBe(2000);
    });
  });
});
