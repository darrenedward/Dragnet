/**
 * Compute a stability score from a PR's scan history — how many consecutive
 * clean rounds a PR has had. A "clean round" is one where rating >= threshold
 * AND no new findings were introduced.
 *
 * The stability score gives users a "ready to merge" verdict based on
 * sustained clean reviews, not just a single rating.
 *
 * Weighted stability extends this by factoring in each run's model trust
 * weight, so a scan from Claude Opus counts more than one from a local
 * Ollama model.
 */

import process from "node:process";
import { STABILITY_WEIGHT_THRESHOLD as WEIGHT_THRESHOLD, lookupModelTrustWeight } from "./modelTrustWeights";

export const STABILITY_RATING_THRESHOLD = 8;
export const STABILITY_MIN_ROUNDS = 3;
/** Re-export from modelTrustWeights — single source of truth. */
export { STABILITY_WEIGHT_THRESHOLD } from "./modelTrustWeights";

export interface RatingTrendEntry {
  runId: string;
  rating: number | null;
  completedAt: Date | null;
  commitHash: string;
  newFindingsCount: number;
  model: string | null;
}

export interface StabilityOptions {
  ratingThreshold?: number;
  minRounds?: number;
}

export interface WeightedStabilityOptions {
  weightThreshold?: number;
  ratingThreshold?: number;
}

export interface StabilityResult {
  consecutiveCleanRounds: number;
  readyToMerge: boolean;
  lastUnstableRunId: string | null;
  weightedStability: number; // sum of trust weights for consecutive clean rounds
}

export interface StabilityProp {
  consecutiveCleanRounds: number;
  readyToMerge: boolean;
  lastUnstableRunId?: string | null;
  weightedStability?: number;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function computeStability(
  ratingTrend: RatingTrendEntry[],
  opts?: StabilityOptions,
): StabilityResult {
  const threshold = opts?.ratingThreshold ?? envInt("DRAGNET_STABILITY_THRESHOLD", STABILITY_RATING_THRESHOLD);
  const minRounds = opts?.minRounds ?? envInt("DRAGNET_STABILITY_MIN_ROUNDS", STABILITY_MIN_ROUNDS);
  const weightThreshold = envInt("DRAGNET_STABILITY_WEIGHT_THRESHOLD", WEIGHT_THRESHOLD);

  if (ratingTrend.length === 0) {
    return { consecutiveCleanRounds: 0, readyToMerge: false, lastUnstableRunId: null, weightedStability: 0 };
  }

  let consecutiveCleanRounds = 0;
  let weightedStability = 0;
  let lastUnstableRunId: string | null = null;

  for (let i = ratingTrend.length - 1; i >= 0; i--) {
    const entry = ratingTrend[i];
    if (entry.rating !== null && entry.rating >= threshold && entry.newFindingsCount === 0) {
      consecutiveCleanRounds++;
      // Add the model's trust weight to the weighted stability sum
      const modelWeight = entry.model ? lookupModelTrustWeight(entry.model) : 0.5;
      weightedStability += modelWeight;
    } else {
      lastUnstableRunId = entry.runId;
      break;
    }
  }

  return {
    consecutiveCleanRounds,
    weightedStability,
    readyToMerge: weightedStability >= weightThreshold,
    lastUnstableRunId,
  };
}

/**
 * Compute a trust-weighted stability score. Same walk as computeStability
 * (newest-first, stop at first unclean round), but each clean round
 * contributes its model's trust weight to the cumulative score instead of
 * incrementing a count.
 *
 * A round is clean if rating >= threshold AND newFindingsCount === 0.
 *
 * readyToMerge is true when weightedStability >= weightThreshold.
 */
export function computeWeightedStability(
  ratingTrend: RatingTrendEntry[],
  lookupWeight: (model: string | null | undefined) => number,
  opts?: WeightedStabilityOptions,
): { weightedStability: number; readyToMerge: boolean } {
  const weightThreshold = opts?.weightThreshold ?? envFloat("DRAGNET_WEIGHT_THRESHOLD", WEIGHT_THRESHOLD);
  const ratingThreshold = opts?.ratingThreshold ?? envInt("DRAGNET_STABILITY_THRESHOLD", STABILITY_RATING_THRESHOLD);

  if (ratingTrend.length === 0) {
    return { weightedStability: 0, readyToMerge: false };
  }

  let weightedStability = 0;

  for (let i = ratingTrend.length - 1; i >= 0; i--) {
    const entry = ratingTrend[i];
    if (entry.rating !== null && entry.rating >= ratingThreshold && entry.newFindingsCount === 0) {
      weightedStability += lookupWeight(entry.model);
    } else {
      break;
    }
  }

  return {
    weightedStability,
    readyToMerge: weightedStability >= weightThreshold,
  };
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
