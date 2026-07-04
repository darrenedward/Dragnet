import process from "node:process";

export const STABILITY_WEIGHT_THRESHOLD = 2.5;

/**
 * Seed trust-weights table. Keys are normalized — lowercase, provider prefix
 * stripped, non-alphanumeric collapsed to `-`. `lookupTrustWeight` does
 * progressive prefix matching so e.g. "gpt-4o-2026-05-13" matches "gpt-4o".
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

  // ── Other cloud providers ──────────────────────────────────────
  minimax: 0.7,
  glm: 0.8,
  "glm-flash": 0.5,
  deepseek: 0.8,
  "gemini-flash": 0.6,
  "gemini-pro": 0.8,
  llama: 0.6,
  qwen: 0.6,
  nemotron: 0.6,

  // ── Local / free ───────────────────────────────────────────────
  ollama: 0.4,
  "lm-studio": 0.4,
  lmstudio: 0.4,
};

let envOverrides: Record<string, number> | null = null;

function computeEnvOverrides(): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const prefix = "DRAGNET_MODEL_TRUST_";
    if (!key.startsWith(prefix)) continue;
    const modelKey = key.slice(prefix.length).toLowerCase().replace(/_/g, "-");
    const num = Number(value);
    if (Number.isFinite(num)) {
      overrides[modelKey] = num;
    }
  }
  return overrides;
}

function normalizeModel(model: string): string {
  const lower = model.toLowerCase();
  const noPrefix = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
  return noPrefix.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

export function lookupTrustWeight(model: string | null | undefined): number {
  if (!model) return 0.5;

  // Local model provider check (before normalization strips the provider prefix)
  if (isLocalModel(model)) return 0.4;

  if (envOverrides === null) {
    envOverrides = computeEnvOverrides();
  }

  const key = normalizeModel(model);

  // 1. Env override wins
  if (envOverrides[key] !== undefined) return envOverrides[key];

  // 2. Exact match
  if (MODEL_TRUST_WEIGHTS[key] !== undefined) return MODEL_TRUST_WEIGHTS[key];

  // 3. Prefix match — longest table key that's a prefix of the input
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

  // 4. Unknown → 0.5
  return 0.5;
}
