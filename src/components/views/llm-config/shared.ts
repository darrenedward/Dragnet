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
export const LLM_PRESETS_CHANGED_EVENT = "dragnet:llm-presets-changed";

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
 * The four preset slots. Each role (chat / embedding) has a primary and
 * a fallback. Fallback is optional — empty string means "no fallback".
 */
export type SlotId =
  | "primaryChat"
  | "fallbackChat"
  | "primaryEmbedding"
  | "fallbackEmbedding";

export type SlotState = Record<SlotId, string>;

/**
 * Local working copy of a preset. Carries the real apiKey (populated from
 * the server on load) plus ephemeral UI state (models cache, fetch status,
 * eye toggle) that never round-trips through the API.
 *
 * showApiKey toggles password vs plain-text display of the field value.
 * The server is source of truth and the route is session-gated, so the key
 * is no longer masked in transit — the eye is only to defeat shoulder-surfers.
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

export const EMPTY_SLOT_STATE: SlotState = {
  primaryChat: "",
  fallbackChat: "",
  primaryEmbedding: "",
  fallbackEmbedding: "",
};

/**
 * Maps the server's masked view into a working copy with all UI-only
 * fields initialized to their defaults.
 *
 * Reads the new primaryX / fallbackX fields when present, falls back to
 * the legacy activeX field names otherwise.
 */
export function fromViewState(data: LlmPresetsState): {
  presets: WorkingPreset[];
  slots: SlotState;
} {
  return {
    presets: data.presets.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      apiKey: p.apiKey || "",
      hasApiKey: p.hasApiKey,
      chatModel: p.chatModel,
      embeddingModel: p.embeddingModel,
      modelsCache: null,
      showApiKey: false,
      fetchResult: null,
      isFetching: false,
    })),
    slots: {
      primaryChat: data.primaryChatPresetId ?? data.activeChatPresetId ?? "",
      fallbackChat: data.fallbackChatPresetId ?? "",
      primaryEmbedding: data.primaryEmbeddingPresetId ?? data.activeEmbeddingPresetId ?? "",
      fallbackEmbedding: data.fallbackEmbeddingPresetId ?? "",
    },
  };
}

/**
 * Builds the PUT body the API expects. apiKey is the user-typed value
 * (empty string means "keep stored" on the server side).
 *
 * Sends both the new primaryX/fallbackX field names and the legacy
 * activeX aliases — server tolerates either shape.
 */
export function toPutBody(presets: WorkingPreset[], slots: SlotState) {
  return {
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      apiKey: p.apiKey,
      chatModel: p.chatModel,
      embeddingModel: p.embeddingModel,
    })),
    primaryChatPresetId: slots.primaryChat,
    fallbackChatPresetId: slots.fallbackChat,
    primaryEmbeddingPresetId: slots.primaryEmbedding,
    fallbackEmbeddingPresetId: slots.fallbackEmbedding,
    activeChatPresetId: slots.primaryChat,
    activeEmbeddingPresetId: slots.primaryEmbedding,
  };
}
