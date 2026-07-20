import OpenAI from "openai";
import {
  getPrimaryChatPreset,
  getPrimaryEmbeddingPreset,
  getFallbackChatPreset,
  getFallbackEmbeddingPreset,
  apiKeyHash,
  resolveMaxIterations,
  type Preset,
} from "@/src/lib/llmPresets";
import { getProviderHealth } from "@/src/lib/providerHealth";

/**
 * SDK-level retry count handed to every OpenAI-compatible client. The
 * SDK retries on 408/409/429/5xx with exponential backoff + jitter.
 * Default of 2 matches the SDK's built-in default; override via
 * `DRAGNET_LLM_RETRY_COUNT` when a flaky endpoint needs more (or a
 * strict-latency endpoint needs fewer). Provider-level quality
 * failures (loop exhaustion without submitReview, malformed streaks)
 * are NOT retried at this layer — those go through the Phase 3
 * circuit breaker instead, which pauses the provider after N quality
 * failures rather than retrying in-place.
 */
const DEFAULT_LLM_RETRY_COUNT = 2;

function getMaxRetries(): number {
  const v = Number(process.env.DRAGNET_LLM_RETRY_COUNT);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_LLM_RETRY_COUNT;
}

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
 * fresh clones with no database presets. Mirrors the prisma.ts pattern.
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
    maxRetries: getMaxRetries(),
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
 * Reads the database-backed preset cache fresh on every call so users
 * don't need to restart the dev server after editing config.
 *
 * Returns null if no chat preset is active or the active preset has
 * no chatModel configured (callers should bail to a fallback).
 */
export function getChatClient(): OpenAI | null {
  const preset = getPrimaryChatPreset();
  if (!preset || !preset.chatModel) return null;
  return clientFor(preset);
}

export function getEmbeddingClient(): OpenAI | null {
  const preset = getPrimaryEmbeddingPreset();
  if (!preset || !preset.embeddingModel) return null;
  return clientFor(preset);
}

export function getChatModel(): string | null {
  const preset = getPrimaryChatPreset();
  return preset?.chatModel || null;
}

export function getEmbeddingModel(): string | null {
  const preset = getPrimaryEmbeddingPreset();
  return preset?.embeddingModel || null;
}

export interface ChainEntry {
  client: OpenAI;
  model: string;
  name: string;
  /**
   * Preset endpoint URL — used by the Phase 3 circuit breaker to
   * compute the `{provider_host}:{model}` key. Mirrors `preset.endpoint`.
   */
  endpoint: string;
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
 *
 * **Phase 3 circuit breaker:** when `opts.repoPath` is supplied,
 * providers whose breaker state is `"open"` are filtered out before
 * the chain is returned. Half-open providers stay in the chain as
 * probes — they're allowed one shot to recover. Skipped providers
 * are logged with their resume time so operators can correlate.
 *
 * Callers without a repo context (CLI tooling, diagnostics) omit
 * `repoPath` and get the unfiltered chain.
 */
export function getChatChain(opts?: { repoPath?: string | null }): ChainEntry[] {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const primary = getPrimaryChatPreset();
  if (primary && primary.chatModel) {
    chain.push({
      client: clientFor(primary),
      model: primary.chatModel,
      name: primary.name,
      endpoint: primary.endpoint,
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
      endpoint: fallback.endpoint,
      maxIterations: resolveMaxIterations(fallback),
    });
  }

  // Phase 3 circuit breaker — filter OPEN providers out, keep HALF-OPEN
  // as probes. Logged so the operator can see why a configured provider
  // was skipped and when it will become eligible again.
  if (opts?.repoPath) {
    return filterOpenProviders(chain, opts.repoPath);
  }

  return chain;
}

/**
 * Filters out providers whose breaker state is `"open"`. Half-open
 * providers are kept — they need a real probe scan to either close or
 * reopen the circuit. Each skipped provider is logged with resume
 * time so operators can correlate chain composition with health state.
 *
 * Pure with respect to the chain: no mutations to caller's array.
 */
function filterOpenProviders(chain: ChainEntry[], repoPath: string): ChainEntry[] {
  const filtered: ChainEntry[] = [];
  for (const entry of chain) {
    const { state, health } = getProviderHealth(repoPath, entry.endpoint, entry.model);
    if (state === "open") {
      const resumeAt = health?.cooldownEndsAt ?? null;
      const resumeIso = resumeAt !== null ? new Date(resumeAt).toISOString() : "unknown";
      console.log(
        `[breaker] skipping provider ${entry.name} (${entry.model}) — circuit open, ` +
          `resume at ${resumeIso}`,
      );
      continue;
    }
    filtered.push(entry);
  }
  return filtered;
}

/**
 * Ordered list of embedding providers. Same shape/semantics as getChatChain.
 */
export function getEmbeddingChain(): ChainEntry[] {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const primary = getPrimaryEmbeddingPreset();
  if (primary && primary.embeddingModel) {
    chain.push({
      client: clientFor(primary),
      model: primary.embeddingModel,
      name: primary.name,
      endpoint: primary.endpoint,
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
      endpoint: fallback.endpoint,
      maxIterations: resolveMaxIterations(fallback),
    });
  }

  return chain;
}
