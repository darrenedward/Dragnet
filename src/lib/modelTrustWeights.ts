import process from "node:process";

/**
 * Weighted stability threshold — the weighted-sum cutoff for
 * merge-readiness. Re-exported by stabilityScore.ts as the single
 * source of truth.
 */
export const STABILITY_WEIGHT_THRESHOLD = 2.5;

/**
 * Seed trust-weights table. Keys are normalized — lowercase, provider
 * prefix stripped, non-alphanumeric collapsed to `-`. `lookupTrustWeight`
 * does progressive prefix matching so e.g. "gpt-4o-2026-05-13" matches
 * "gpt-4o".
 *
 * **LAST VERIFIED: 2026-07.** As new models ship, add entries here.
 * Unknown models return 0.5; env overrides via DRAGNET_MODEL_TRUST_<KEY>=N.
 */
export const MODEL_TRUST_WEIGHTS: Record<string, number> = {
  // ── Anthropic ───────────────────────────────────────────────────
  "claude-opus": 1.0,
  "claude-sonnet": 0.9,
  "claude-haiku": 0.7,

  // ── OpenAI ─────────────────────────────────────────────────────
  "gpt-4o": 0.9,
  "gpt-4o-mini": 0.5,
  "gpt-5": 0.95,
  "gpt-5-mini": 0.6,
  o1: 0.95,
  o3: 0.9,

  // ── Google Gemini ────────────────────────────────────────────────
  "gemini-pro": 0.8,
  "gemini-flash": 0.6,

  // ── Z.ai / GLM ────────────────────────────────────────────────────
  "glm-4": 0.8,
  "glm-4-flash": 0.5,
  glm: 0.7,

  // ── Minimax ─────────────────────────────────────────────────────
  minimax: 0.7,

  // ── DeepSeek ────────────────────────────────────────────────────
  deepseek: 0.8,

  // ── Meta Llama ──────────────────────────────────────────────────
  llama: 0.6,

  // ── Qwen ────────────────────────────────────────────────────────
  qwen: 0.6,

  // ── NVIDIA Nemotron ─────────────────────────────────────────────
  nemotron: 0.6,

  // ── Local / self-hosted ─────────────────────────────────────────
  ollama: 0.4,
  "lm-studio": 0.4,
  lmstudio: 0.4,
};

/**
 * Normalize a model ID for table lookup:
 *  - lowercase
 *  - drop provider prefix (e.g. "openai/gpt-5" → "gpt-5")
 *  - collapse non-alphanumeric to `-`
 */
function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  const noPrefix = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
  return noPrefix.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

let envOverrides: Record<string, number> | null = null;

function computeEnvOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const prefix = "DRAGNET_MODEL_TRUST_";
    if (!key.startsWith(prefix)) continue;
    const modelKey = key
      .slice(prefix.length)
      .toLowerCase()
      .replace(/_/g, "-");
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      overrides[modelKey] = num;
    }
  }
  return overrides;
}

export function clearWeightCache(): void {
  envOverrides = null;
}

function isLocalModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("ollama") ||
    lower.includes("lm-studio") ||
    lower.includes("lmstudio")
  );
}

/**
 * Look up the trust weight for a model. Resolution order:
 *  1. Local-model provider check (Ollama / LM Studio → 0.4)
 *  2. Env override DRAGNET_MODEL_TRUST_<KEY>
 *  3. Exact table match on normalized key
 *  4. Prefix match: longest table key that's a prefix of the input
 *  5. Unknown → 0.5 (neutral default)
 */
export function lookupTrustWeight(model: string | null | undefined): number {
  if (!model) return 0.5;

  if (isLocalModel(model)) return 0.4;

  if (envOverrides === null) {
    envOverrides = computeEnvOverrides();
  }

  const key = normalizeModel(model);

  if (envOverrides[key] !== undefined) return envOverrides[key];

  if (MODEL_TRUST_WEIGHTS[key] !== undefined) return MODEL_TRUST_WEIGHTS[key];

  let bestMatch: string | null = null;
  for (const tableKey of Object.keys(MODEL_TRUST_WEIGHTS)) {
    if (key === tableKey) continue;
    if (key.startsWith(tableKey)) {
      if (bestMatch === null || tableKey.length > bestMatch.length) {
        bestMatch = tableKey;
      }
    }
  }
  if (bestMatch !== null) return MODEL_TRUST_WEIGHTS[bestMatch];

  return 0.5;
}

/**
 * Alias for `lookupTrustWeight` — main's naming. Kept for back-compat
 * with callers that adopted the longer name before the merge.
 */
export const lookupModelTrustWeight = lookupTrustWeight;

/**
 * Alias for `MODEL_TRUST_WEIGHTS` — main's naming. Kept for back-compat
 * with callers that adopted the shorter name before the merge.
 */
export const TRUST_WEIGHTS = MODEL_TRUST_WEIGHTS;
