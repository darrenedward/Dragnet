/**
 * LLM pricing lookup + cost computation for cost telemetry.
 *
 * Used by `reviewService.ts` to compute per-scan cost from
 * `response.usage` token counts. Persisted to `ReviewRun.tokensUsed`
 * (Phase 2).
 *
 * **Honest pricing policy:** unknown models default to $0 with a
 * console warning. We do NOT fabricate prices — a wrong number is
 * worse than "cost not tracked." Users who want exact accounting for
 * an unseeded model can set env overrides per model.
 *
 * **LAST VERIFIED: 2026-07.** Provider pricing changes frequently.
 * Re-verify before treating cost data as authoritative. The numbers
 * below are approximate baselines for ordering-of-magnitude sorting
 * (e.g. "this scan cost cents, not dollars").
 *
 * **Env override pattern:** for a model normalizable to `gpt-5`,
 * set `DRAGNET_PRICE_GPT_5_IN` and `DRAGNET_PRICE_GPT_5_OUT` (USD
 * per 1M tokens). Env wins over the seeded table.
 */

export interface ModelPrice {
  /** USD per 1M prompt tokens. */
  inputPer1M: number;
  /** USD per 1M completion tokens. */
  outputPer1M: number;
  currency: "USD";
}

const USD = (inputPer1M: number, outputPer1M: number): ModelPrice => ({
  inputPer1M,
  outputPer1M,
  currency: "USD",
});

/**
 * Seeded pricing table. Keys are normalization targets (lowercase,
 * non-alphanumeric collapsed to `-`). `lookupPrice` does progressive
 * matching so e.g. "gpt-5.2" matches "gpt-5" via prefix.
 *
 * Numbers are approximate baselines as of 2026-07. Free providers
 * (Ollama, LM Studio, OpenRouter `:free` suffix) are $0.
 */
export const PRICING_TABLE: Record<string, ModelPrice> = {
  // ── Local / free ───────────────────────────────────────────────
  ollama: USD(0, 0),
  "lm-studio": USD(0, 0),
  lmstudio: USD(0, 0),
  "openrouter-free": USD(0, 0),

  // ── OpenAI ─────────────────────────────────────────────────────
  "gpt-4o": USD(2.5, 10),
  "gpt-4o-mini": USD(0.15, 0.6),
  "gpt-5": USD(5, 15),
  "gpt-5-mini": USD(0.5, 1.5),
  o1: USD(15, 60),
  o3: USD(10, 40),

  // ── Anthropic ──────────────────────────────────────────────────
  "claude-opus": USD(15, 75),
  "claude-sonnet": USD(3, 15),
  "claude-haiku": USD(0.25, 1.25),

  // ── Google Gemini ──────────────────────────────────────────────
  "gemini-flash": USD(0.075, 0.3),
  "gemini-pro": USD(1.25, 5),

  // ── NVIDIA ─────────────────────────────────────────────────────
  nemotron: USD(0.4, 0.6),

  // ── Z.ai / GLM ─────────────────────────────────────────────────
  glm: USD(0.14, 0.28),
  "glm-turbo": USD(0.07, 0.14),
  "glm-flash": USD(0.07, 0.14),

  // ── Minimax ────────────────────────────────────────────────────
  minimax: USD(0.1, 0.3),

  // ── DeepSeek ───────────────────────────────────────────────────
  deepseek: USD(0.14, 0.28),

  // ── Meta Llama via cloud routers ───────────────────────────────
  llama: USD(0.2, 0.6),

  // ── Qwen ───────────────────────────────────────────────────────
  qwen: USD(0.2, 0.6),
};

/**
 * Detect free-tier models by name pattern:
 *  - OpenRouter `:free` suffix
 *  - Ollama preset (contains "ollama")
 *  - LM Studio preset (contains "lm-studio" / "lmstudio")
 *
 * Note: local models served via LM Studio often have generic names
 * (e.g. "ornith-1.0-9b") with no provider hint in the model ID. The
 * caller knows the preset endpoint; if it's localhost, treat as free.
 */
function isFreeTierModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.endsWith(":free") ||
    lower.includes("ollama") ||
    lower.includes("lm-studio") ||
    lower.includes("lmstudio")
  );
}

/**
 * Normalize a model ID for table lookup:
 *  - lowercase
 *  - drop provider prefix (e.g. "openai/gpt-5" → "gpt-5")
 *  - drop `:free` suffix
 *  - collapse non-alphanumeric to `-`
 */
function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  const noPrefix = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
  const noFree = noPrefix.replace(/:free$/, "").trim();
  return noFree.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Drop "noise" segments from a normalized key:
 *  - pure-number segments after the first ("gpt-5-2" → "gpt")
 *  - parameter-count segments ("550b", "9b")
 *  - MoE activation-count segments ("a55b")
 *
 * Used as a secondary lookup strategy when exact match fails.
 */
function dropNoiseSegments(key: string): string {
  const segments = key.split("-");
  const kept: string[] = [];
  for (const seg of segments) {
    if (kept.length > 0 && /^\d+$/.test(seg)) continue; // pure number after first
    if (/^\d+b$/i.test(seg)) continue; // parameter count: 550b, 9b
    if (/^a\d+b$/i.test(seg)) continue; // activation count: a55b
    kept.push(seg);
  }
  return kept.join("-");
}

/**
 * Look up the price for a model. Resolution order:
 *  1. Free-tier detection by name pattern → $0
 *  2. Env override `DRAGNET_PRICE_<KEY>_IN` / `_OUT` (USD per 1M)
 *  3. Exact table match on normalized key
 *  4. Exact table match on noise-stripped key (drops version +
 *     parameter-count segments)
 *  5. Prefix match: longest table key that's a prefix of the
 *     normalized key (so "gpt-5.2" matches "gpt-5")
 *  6. Unknown → $0 with console warning
 */
export function lookupPrice(model: string): ModelPrice {
  if (!model) return USD(0, 0);

  // 1. Free-tier short-circuit by name pattern
  if (isFreeTierModel(model)) return USD(0, 0);

  const key = normalizeModel(model);

  // 2. Env override
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const envIn = process.env[`DRAGNET_PRICE_${envKey}_IN`];
  const envOut = process.env[`DRAGNET_PRICE_${envKey}_OUT`];
  if (envIn !== undefined || envOut !== undefined) {
    const inN = Number(envIn ?? 0);
    const outN = Number(envOut ?? 0);
    if (Number.isFinite(inN) && Number.isFinite(outN)) {
      return USD(inN, outN);
    }
  }

  // 3. Exact match
  if (PRICING_TABLE[key]) return PRICING_TABLE[key];

  // 4. Noise-stripped match
  const stripped = dropNoiseSegments(key);
  if (stripped && stripped !== key && PRICING_TABLE[stripped]) {
    return PRICING_TABLE[stripped];
  }

  // 5. Prefix match — longest table key that's a prefix of the input
  let bestMatch: string | null = null;
  for (const tableKey of Object.keys(PRICING_TABLE)) {
    if (key === tableKey) continue; // already tried
    if (key.startsWith(tableKey)) {
      if (bestMatch === null || tableKey.length > bestMatch.length) {
        bestMatch = tableKey;
      }
    }
  }
  if (bestMatch) return PRICING_TABLE[bestMatch];

  // 6. Unknown — honest $0 with warning
  console.warn(
    `[llmPricing] no price entry for model "${model}" (normalized: "${key}"); ` +
      `returning $0. Set DRAGNET_PRICE_${envKey}_IN and DRAGNET_PRICE_${envKey}_OUT to override.`,
  );
  return USD(0, 0);
}

/**
 * Compute cost for a (model, promptTokens, completionTokens) tuple.
 * Returns USD amount as a number. Rounding to 6 decimal places to
 * avoid float noise on tiny per-1M-token fractions.
 */
export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): { costUsd: number; price: ModelPrice } {
  const price = lookupPrice(model);
  const cost =
    (price.inputPer1M * (promptTokens ?? 0)) / 1_000_000 +
    (price.outputPer1M * (completionTokens ?? 0)) / 1_000_000;
  return { costUsd: Math.round(cost * 1e6) / 1e6, price };
}
