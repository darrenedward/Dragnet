/**
 * Model trust weights for confidence-weighted stability scoring.
 *
 * Used by `stabilityScore.ts` to compute weighted stability where scans
 * from high-trust models (Claude Opus, GPT-4o) count more toward
 * merge-readiness than scans from low-trust models (Ollama locals).
 *
 * **LAST VERIFIED: 2026-07.** Trust weights are subjective estimates
 * of model reliability for security/correctness review. Adjust based
 * on observed performance.
 *
 * **Env override pattern:** for a model normalizable to `gpt-5`,
 * set `DRAGNET_MODEL_TRUST_GPT_5=0.95` (0.0 to 1.0). Env wins
 * over the seeded table.
 */

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

/**
 * Look up the trust weight for a model. Resolution order:
 *  1. Env override `DRAGNET_MODEL_TRUST_<KEY>` (0.0 to 1.0)
 *  2. Exact table match on normalized key
 *  3. Prefix match: longest table key that's a prefix of the
 *     normalized key (so "gpt-4o-2026-05-13" matches "gpt-4o")
 *  4. Unknown → 0.5 (neutral default)
 */
export function lookupModelTrustWeight(model: string): number {
  if (!model) return 0.5;

  const key = normalizeModel(model);

  // 1. Env override
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const envValue = process.env[`DRAGNET_MODEL_TRUST_${envKey}`];
  if (envValue !== undefined) {
    const weight = Number(envValue);
    if (Number.isFinite(weight) && weight >= 0 && weight <= 1) {
      return weight;
    }
    console.warn(
      `[modelTrustWeights] invalid env value for DRAGNET_MODEL_TRUST_${envKey}="${envValue}"; ` +
        `must be 0.0 to 1.0, falling back to table.`,
    );
  }

  // 2. Exact match
  if (TRUST_WEIGHTS[key] !== undefined) return TRUST_WEIGHTS[key];

  // 3. Prefix match — longest table key that's a prefix of the input
  let bestMatch: string | null = null;
  for (const tableKey of Object.keys(TRUST_WEIGHTS)) {
    if (key === tableKey) continue; // already tried
    if (key.startsWith(tableKey)) {
      if (bestMatch === null || tableKey.length > bestMatch.length) {
        bestMatch = tableKey;
      }
    }
  }
  if (bestMatch !== null) return TRUST_WEIGHTS[bestMatch];

  // 4. Unknown — neutral default
  return 0.5;
}

/**
 * Seeded trust weights table. Keys are normalization targets (lowercase,
 * non-alphanumeric collapsed to `-`). Values range from 0.0 (no trust) to
 * 1.0 (full trust).
 *
 * Weights reflect observed reliability for security/correctness review:
 * - 1.0: Claude Opus — highest reliability, strong security reasoning
 * - 0.9: Claude Sonnet, GPT-4o — excellent, minor edge cases
 * - 0.8: GLM-4.6 — good performance, some missed edge cases
 * - 0.7: Claude Haiku, Minimax — capable but less consistent
 * - 0.5: Baseline — neutral, used for unknown models
 * - 0.4: Ollama locals — variable quality, depends heavily on model
 */
export const TRUST_WEIGHTS: Record<string, number> = {
  // ── Anthropic Claude ──────────────────────────────────────────────
  "claude-opus": 1.0,
  "claude-sonnet": 0.9,
  "claude-haiku": 0.7,

  // ── OpenAI ───────────────────────────────────────────────────────
  "gpt-4o": 0.9,
  "gpt-4o-mini": 0.5,
  "gpt-5": 1.0, // future flagship, assuming parity with Opus
  "gpt-5-mini": 0.6,
  o1: 0.95, // reasoning model, high reliability
  o3: 0.95,

  // ── Google Gemini ────────────────────────────────────────────────
  "gemini-pro": 0.8,
  "gemini-flash": 0.6,

  // ── Z.ai / GLM ────────────────────────────────────────────────────
  "glm-4": 0.8, // GLM-4.6 family
  "glm-4-flash": 0.5,
  glm: 0.7, // GLM-4.5 and earlier

  // ── Minimax ────────────────────────────────────────────────────────
  minimax: 0.7,

  // ── DeepSeek ─────────────────────────────────────────────────────
  deepseek: 0.75,

  // ── Meta Llama ───────────────────────────────────────────────────
  llama: 0.65, // cloud-hosted Llama models

  // ── Qwen ─────────────────────────────────────────────────────────
  qwen: 0.7,

  // ── NVIDIA ────────────────────────────────────────────────────────
  nemotron: 0.75,

  // ── Local / self-hosted ───────────────────────────────────────────
  ollama: 0.4, // variable quality, depends on model
  "lm-studio": 0.4,
  lmstudio: 0.4,
};
