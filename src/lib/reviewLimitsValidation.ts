import type { ReviewLimits } from "./prSizeConfig";

/**
 * Validation bounds for review-limits PUT body. Sane envelope, not
 * tight clamps — mirrors plan §4.4.
 */
interface Bounds {
  min: number;
  max: number;
}

const BOUNDS: Record<keyof ReviewLimits, Bounds> = {
  chunkLineCap: { min: 300, max: 3000 },
  minUsefulChunkLines: { min: 50, max: 500 },
  normalMaxLines: { min: 200, max: 5000 },
  normalMaxCodeFiles: { min: 5, max: 200 },
  oversizedLines: { min: 1000, max: 20000 },
  oversizedCodeFiles: { min: 20, max: 500 },
  maxFilesPerReview: { min: 0, max: 500 },
};

const FIELDS: Array<keyof ReviewLimits> = [
  "chunkLineCap",
  "minUsefulChunkLines",
  "normalMaxLines",
  "normalMaxCodeFiles",
  "oversizedLines",
  "oversizedCodeFiles",
  "maxFilesPerReview",
];

/**
 * Throws Error with a descriptive message on any invalid input.
 * Used by the API route so client-side bugs can't corrupt the file.
 */
export function validateLimits(input: unknown): ReviewLimits {
  if (!input || typeof input !== "object") {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  const out: Partial<ReviewLimits> = {};
  for (const field of FIELDS) {
    const v = obj[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${field} must be a finite number.`);
    }
    const { min, max } = BOUNDS[field];
    // Special case: maxFilesPerReview allows 0 (off) as the lower bound.
    if (field === "maxFilesPerReview") {
      if (v !== 0 && (v < 20 || v > max)) {
        throw new Error(
          `${field} must be 0 (off) or between 20 and ${max}.`,
        );
      }
      out[field] = Math.floor(v);
      continue;
    }
    if (v < min || v > max) {
      throw new Error(`${field} must be between ${min} and ${max}.`);
    }
    out[field] = Math.floor(v);
  }
  // Relational bounds.
  if ((out.oversizedLines as number) <= (out.normalMaxLines as number)) {
    throw new Error("oversizedLines must be greater than normalMaxLines.");
  }
  if ((out.oversizedCodeFiles as number) <= (out.normalMaxCodeFiles as number)) {
    throw new Error("oversizedCodeFiles must be greater than normalMaxCodeFiles.");
  }
  if ((out.chunkLineCap as number) <= (out.minUsefulChunkLines as number)) {
    throw new Error("chunkLineCap must be greater than minUsefulChunkLines.");
  }
  return out as ReviewLimits;
}
