import { describe, expect, it } from "vitest";

import { validateLimits } from "../src/lib/reviewLimitsValidation";
import { DEFAULT_LIMITS } from "../src/lib/prSizeConfig";

describe("review-limits route validateLimits", () => {
  it("accepts the defaults as valid", () => {
    expect(validateLimits(DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
  });

  it("floors fractional inputs (UI sliders can produce 0.5)", () => {
    const got = validateLimits({
      ...DEFAULT_LIMITS,
      chunkLineCap: 1500.9,
      minUsefulChunkLines: 200.4,
    });
    expect(got.chunkLineCap).toBe(1500);
    expect(got.minUsefulChunkLines).toBe(200);
  });

  it("rejects chunkLineCap below 300", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, chunkLineCap: 200 }),
    ).toThrow(/chunkLineCap must be between 300 and 3000/);
  });

  it("rejects oversizedLines <= normalMaxLines", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, normalMaxLines: 3000, oversizedLines: 3000 }),
    ).toThrow(/oversizedLines must be greater than normalMaxLines/);
  });

  it("rejects oversizedCodeFiles <= normalMaxCodeFiles", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, normalMaxCodeFiles: 100, oversizedCodeFiles: 100 }),
    ).toThrow(/oversizedCodeFiles must be greater than normalMaxCodeFiles/);
  });

  it("rejects chunkLineCap <= minUsefulChunkLines", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, chunkLineCap: 300, minUsefulChunkLines: 300 }),
    ).toThrow(/chunkLineCap must be greater than minUsefulChunkLines/);
  });

  it("maxFilesPerReview=0 means 'off' and is accepted", () => {
    expect(validateLimits({ ...DEFAULT_LIMITS, maxFilesPerReview: 0 }).maxFilesPerReview).toBe(0);
  });

  it("rejects maxFilesPerReview between 1 and 19 (no-mans-land)", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, maxFilesPerReview: 10 }),
    ).toThrow(/maxFilesPerReview must be 0 \(off\) or between 20 and 500/);
  });

  it("rejects non-numeric fields", () => {
    expect(() =>
      validateLimits({ ...DEFAULT_LIMITS, chunkLineCap: "big" as unknown as number }),
    ).toThrow(/chunkLineCap must be a finite number/);
  });

  it("enforces the global concurrent scan limit", () => {
    expect(validateLimits({ ...DEFAULT_LIMITS, maxConcurrentScans: 32 }).maxConcurrentScans).toBe(32);
    expect(() => validateLimits({ ...DEFAULT_LIMITS, maxConcurrentScans: 0 })).toThrow(
      /maxConcurrentScans must be between 1 and 32/,
    );
    expect(() => validateLimits({ ...DEFAULT_LIMITS, maxConcurrentScans: 33 })).toThrow(
      /maxConcurrentScans must be between 1 and 32/,
    );
  });

  it("rejects non-object body", () => {
    expect(() => validateLimits(null)).toThrow(/Expected an object body/);
  });
});
