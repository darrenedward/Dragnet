import OpenAI from "openai";
import {
  getPrimaryChatPreset,
  getPrimaryEmbeddingPreset,
  getFallbackChatPreset,
  getFallbackEmbeddingPreset,
  apiKeyHash,
  migrateFromEnvLocalIfNeeded,
  resolveMaxIterations,
  type Preset,
} from "@/src/lib/llmPresets";

/**
 * Dual lazy singletons for the OpenAI-compatible client.
 *
 * Chat and embedding roles can be served by different presets (e.g.
 * OpenRouter for chat, local Ollama for embeddings). Each getter looks
 * up its active preset, builds a client keyed on
 * `${presetId}|${endpoint}|${sha256(apiKey)}`, and memoizes on
 * globalThis so dev hot-reload doesn't leak sockets.
 *
 * Multi-provider fallback: `getChatChain()` / `getEmbeddingChain()` return
 * an ordered list of providers (primary first, fallback second). Callers
 * iterate and try each in turn. The single-client getters
 * (`getChatClient`/`getChatModel`/etc) remain as shortcuts for the
 * primary slot.
 *
 * Not instantiated at module load — that would break `next build` on
 * fresh clones with no presets file. Mirrors the prisma.ts pattern.
 *
 * Returns null if no preset is active for the requested role. Callers
 * handle gracefully (review returns empty findings + actionable
 * systemWarn, embedding service returns empty vectors).
 */

interface CachedClient {
  client: OpenAI;
  cacheKey: string;
}

const globalForLlm = globalThis as unknown & {
  __llmChatClient?: CachedClient | null;
  __llmEmbeddingClient?: CachedClient | null;
  /** Per-preset cache used by the chain getters. Keyed by cacheKey. */
  __llmClientCache?: Map<string, OpenAI>;
};

function buildClient(preset: Preset): OpenAI {
  return new OpenAI({
    apiKey: preset.apiKey || "no-key-required",
    baseURL: preset.endpoint,
  });
}

function cacheKeyFor(preset: Preset): string {
  return `${preset.id}|${preset.endpoint}|${apiKeyHash(preset.apiKey || "")}`;
}

/**
 * Returns a cached OpenAI client for the given preset, building one if
 * needed. Uses a Map on globalThis so dev hot-reload doesn't leak sockets
 * and so the chain getters can cache multiple providers simultaneously.
 */
function clientFor(preset: Preset): OpenAI {
  const key = cacheKeyFor(preset);
  if (!globalForLlm.__llmClientCache) {
    globalForLlm.__llmClientCache = new Map();
  }
  const cached = globalForLlm.__llmClientCache.get(key);
  if (cached) return cached;
  const client = buildClient(preset);
  globalForLlm.__llmClientCache.set(key, client);
  return client;
}

/**
 * Returns the OpenAI client for the currently-active chat preset.
 * Reads the presets file fresh on every call (~2KB, sub-ms) so users
 * don't need to restart the dev server after editing config.
 *
 * Returns null if no chat preset is active or the active preset has
 * no chatModel configured (callers should bail to a fallback).
 */
export function getChatClient(): OpenAI | null {
  migrateFromEnvLocalIfNeeded();
  const preset = getPrimaryChatPreset();
  if (!preset || !preset.chatModel) return null;
  return clientFor(preset);
}

export function getEmbeddingClient(): OpenAI | null {
  migrateFromEnvLocalIfNeeded();
  const preset = getPrimaryEmbeddingPreset();
  if (!preset || !preset.embeddingModel) return null;
  return clientFor(preset);
}

export function getChatModel(): string | null {
  migrateFromEnvLocalIfNeeded();
  const preset = getPrimaryChatPreset();
  return preset?.chatModel || null;
}

export function getEmbeddingModel(): string | null {
  migrateFromEnvLocalIfNeeded();
  const preset = getPrimaryEmbeddingPreset();
  return preset?.embeddingModel || null;
}

export interface ChainEntry {
  client: OpenAI;
  model: string;
  name: string;
  /**
   * Agentic-loop iteration cap for this provider. Resolved from the
   * preset's optional maxIterations field; falls back to
   * DEFAULT_MAX_ITERATIONS when absent.
   */
  maxIterations: number;
}

/**
 * Ordered list of chat providers to try. Primary first, fallback second
 * (skipped if unset or identical to primary). Empty array if no chat
 * provider is configured at all.
 *
 * Callers iterate and try each entry — catch per-provider errors and
 * continue to the next. After exhaustion, surface an actionable error
 * (don't fabricate templated output).
 */
export function getChatChain(): ChainEntry[] {
  migrateFromEnvLocalIfNeeded();
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const primary = getPrimaryChatPreset();
  if (primary && primary.chatModel) {
    chain.push({
      client: clientFor(primary),
      model: primary.chatModel,
      name: primary.name,
      maxIterations: resolveMaxIterations(primary),
    });
    seen.add(primary.id);
  }

  const fallback = getFallbackChatPreset();
  if (fallback && fallback.chatModel && !seen.has(fallback.id)) {
    chain.push({
      client: clientFor(fallback),
      model: fallback.chatModel,
      name: fallback.name,
      maxIterations: resolveMaxIterations(fallback),
    });
  }

  return chain;
}

/**
 * Ordered list of embedding providers. Same shape/semantics as getChatChain.
 */
export function getEmbeddingChain(): ChainEntry[] {
  migrateFromEnvLocalIfNeeded();
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const primary = getPrimaryEmbeddingPreset();
  if (primary && primary.embeddingModel) {
    chain.push({
      client: clientFor(primary),
      model: primary.embeddingModel,
      name: primary.name,
      maxIterations: resolveMaxIterations(primary),
    });
    seen.add(primary.id);
  }

  const fallback = getFallbackEmbeddingPreset();
  if (fallback && fallback.embeddingModel && !seen.has(fallback.id)) {
    chain.push({
      client: clientFor(fallback),
      model: fallback.embeddingModel,
      name: fallback.name,
      maxIterations: resolveMaxIterations(fallback),
    });
  }

  return chain;
}
