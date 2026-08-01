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
 * Chat agentic-loop cap bounds. Min is a floor so presets cannot silently
 * run with absurdly low budgets (e.g. 2) that burn tools without room for
 * submitReview. Keep in sync with llm-config UI `MAX_ITERATIONS_BOUNDS`.
 */
export const MAX_ITERATIONS_BOUNDS = { min: 4, max: 32 } as const;

export function resolveMaxIterations(preset: Pick<Preset, "maxIterations">): number {
  const v = preset.maxIterations;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_ITERATIONS;
  const clamped = Math.floor(v);
  // Below floor: clamp up so legacy stored values still get a usable budget.
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
