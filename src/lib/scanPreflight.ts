import { getPrimaryChatPreset, getPrimaryEmbeddingPreset, type Preset } from "@/src/lib/llmPresets";

export type ScanConfigurationRole = "chat" | "embedding";

export interface ScanConfigurationIssue {
  role: ScanConfigurationRole;
  label: string;
  provider: string | null;
  reason: "missing_provider" | "missing_model" | "missing_api_key";
}

/**
 * Local OpenAI-compatible servers commonly do not require authentication.
 * Cloud endpoints do: an empty key there would otherwise reach the provider
 * and fail only after the scan has already been admitted.
 */
function endpointNeedsApiKey(endpoint: string): boolean {
  return !/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/i.test(endpoint);
}

function checkPreset(
  role: ScanConfigurationRole,
  label: string,
  preset: Preset | null,
  model: "chatModel" | "embeddingModel",
): ScanConfigurationIssue | null {
  if (!preset) return { role, label, provider: null, reason: "missing_provider" };
  if (!preset[model]?.trim()) return { role, label, provider: preset.name, reason: "missing_model" };
  if (endpointNeedsApiKey(preset.endpoint) && !preset.apiKey.trim()) {
    return { role, label, provider: preset.name, reason: "missing_api_key" };
  }
  return null;
}

export function getScanConfigurationIssues(): ScanConfigurationIssue[] {
  return [
    checkPreset("chat", "Chat review", getPrimaryChatPreset(), "chatModel"),
    checkPreset("embedding", "Codebase embeddings", getPrimaryEmbeddingPreset(), "embeddingModel"),
  ].filter((issue): issue is ScanConfigurationIssue => issue !== null);
}
