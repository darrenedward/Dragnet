import type { LlmPresetsState } from "../../../lib/types";

/**
 * Shared types and helpers for the two-tab LLM config UI.
 *
 * The directory splits the previous monolithic LlmConfigView.tsx into
 * focused modules: this file holds everything shared (types, defaults,
 * the working-copy mappers, and the cross-component event name used to
 * signal the sidebar that presets were saved).
 */

export const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

/**
 * Sidebar / other tabs listen on this event so they refresh immediately
 * after a save instead of waiting for the next poll tick. Dispatched on
 * window from index.tsx after a successful PUT.
 */
export const LLM_PRESETS_CHANGED_EVENT = "greploop:llm-presets-changed";

export type RoleAccent = "cyan" | "indigo";

export interface RemoteModel {
  id: string;
  name?: string;
}

export interface FetchResult {
  success: boolean;
  message: string;
  count?: number;
}

export interface SaveResult {
  success: boolean;
  message: string;
}

/**
 * Local working copy of a preset. Differs from LlmPresetView by carrying
 * apiKey as free-text (empty string when the user hasn't typed a new key —
 * server preserves the stored value in that case).
 *
 * Also tracks ephemeral UI state (models cache, fetch status, eye toggle)
 * that never round-trips through the API.
 */
export interface WorkingPreset {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
  modelsCache: RemoteModel[] | null;
  showApiKey: boolean;
  fetchResult: FetchResult | null;
  isFetching: boolean;
}

export function newPreset(): WorkingPreset {
  return {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    endpoint: DEFAULT_ENDPOINT,
    apiKey: "",
    hasApiKey: false,
    chatModel: "",
    embeddingModel: "",
    modelsCache: null,
    showApiKey: false,
    fetchResult: null,
    isFetching: false,
  };
}

/**
 * Maps the server's masked view into a working copy with all UI-only
 * fields initialized to their defaults.
 */
export function fromViewState(data: LlmPresetsState): {
  presets: WorkingPreset[];
  activeChatId: string;
  activeEmbeddingId: string;
} {
  return {
    presets: data.presets.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      apiKey: "",
      hasApiKey: p.hasApiKey,
      chatModel: p.chatModel,
      embeddingModel: p.embeddingModel,
      modelsCache: null,
      showApiKey: false,
      fetchResult: null,
      isFetching: false,
    })),
    activeChatId: data.activeChatPresetId,
    activeEmbeddingId: data.activeEmbeddingPresetId,
  };
}

/**
 * Builds the PUT body the API expects. apiKey is the user-typed value
 * (empty string means "keep stored" on the server side).
 */
export function toPutBody(
  presets: WorkingPreset[],
  activeChatId: string,
  activeEmbeddingId: string,
) {
  return {
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      apiKey: p.apiKey,
      chatModel: p.chatModel,
      embeddingModel: p.embeddingModel,
    })),
    activeChatPresetId: activeChatId,
    activeEmbeddingPresetId: activeEmbeddingId,
  };
}
