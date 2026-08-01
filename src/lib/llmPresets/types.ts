import { createHash } from "node:crypto";

export interface Preset {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  maxIterations?: number;
}

export interface PresetView {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
  maxIterations?: number;
}

export interface PresetsFile {
  presets: Preset[];
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
}

export const DEFAULT_MAX_ITERATIONS = 16;

/**
 * Chat agentic-loop cap bounds.
 * - min 1: strong models may finish in one submitReview turn
 * - low 2–3: smart models that need a tool peek then submit
 * - higher: weaker / local models that need more tool rounds
 * Keep in sync with llm-config UI `MAX_ITERATIONS_BOUNDS`.
 * Last iteration is reserved for forced submit when no review yet
 * (`agenticFinish.shouldForceSubmitPath`).
 */
export const MAX_ITERATIONS_BOUNDS = { min: 1, max: 32 } as const;

export function resolveMaxIterations(preset: Pick<Preset, "maxIterations">): number {
  const v = preset.maxIterations;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_ITERATIONS;
  const clamped = Math.floor(v);
  if (clamped < MAX_ITERATIONS_BOUNDS.min) return MAX_ITERATIONS_BOUNDS.min;
  // Above ceiling: fall back to default (same as historical behavior).
  if (clamped > MAX_ITERATIONS_BOUNDS.max) return DEFAULT_MAX_ITERATIONS;
  return clamped;
}

export function apiKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export interface RemoteModel {
  id: string;
  name?: string;
}

export interface RemoteModelsResult {
  ok: boolean;
  count?: number;
  models?: RemoteModel[];
  error?: string;
}
