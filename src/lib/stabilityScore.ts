/**
 * Compute a stability score from a PR's scan history — how many consecutive
 * clean rounds a PR has had. A "clean round" is one where rating >= threshold
 * AND no new findings were introduced.
 *
 * The stability score gives users a "ready to merge" verdict based on
 * sustained clean reviews, not just a single rating.
 */

import process from "node:process";

export const STABILITY_RATING_THRESHOLD = 8;
export const STABILITY_MIN_ROUNDS = 3;

export interface RatingTrendEntry {
  runId: string;
  rating: number | null;
  completedAt: Date | null;
  commitHash: string;
  newFindingsCount: number;
}

export interface StabilityOptions {
  ratingThreshold?: number;
  minRounds?: number;
}

export interface StabilityResult {
  consecutiveCleanRounds: number;
  readyToMerge: boolean;
  lastUnstableRunId: string | null;
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

  if (ratingTrend.length === 0) {
    return { consecutiveCleanRounds: 0, readyToMerge: false, lastUnstableRunId: null };
  }

  let consecutiveCleanRounds = 0;
  let lastUnstableRunId: string | null = null;

  for (let i = ratingTrend.length - 1; i >= 0; i--) {
    const entry = ratingTrend[i];
    if (entry.rating !== null && entry.rating >= threshold && entry.newFindingsCount === 0) {
      consecutiveCleanRounds++;
    } else {
      lastUnstableRunId = entry.runId;
      break;
    }
  }

  return {
    consecutiveCleanRounds,
    readyToMerge: consecutiveCleanRounds >= minRounds,
    lastUnstableRunId,
  };
}
