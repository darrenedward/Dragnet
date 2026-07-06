/**
 * Compute a stability score from a PR's scan history — how many consecutive
 * clean rounds a PR has had. A "clean round" is one where rating >= threshold
 * AND no new findings were introduced.
 *
 * The stability score gives users a "ready to merge" verdict based on
 * sustained clean reviews, not just a single rating.
 */

import process from "node:process";
import { lookupModelTrustWeight } from "./modelTrustWeights";

export const STABILITY_RATING_THRESHOLD = 8;
export const STABILITY_MIN_ROUNDS = 3;
export const STABILITY_WEIGHT_THRESHOLD = 2.5; // weighted sum needed for merge-readiness

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
  const weightThreshold = envInt("DRAGNET_STABILITY_WEIGHT_THRESHOLD", STABILITY_WEIGHT_THRESHOLD);

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
