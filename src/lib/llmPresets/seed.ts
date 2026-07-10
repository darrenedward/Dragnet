import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/src/lib/prisma";
import { encryptApiKey } from "./crypto";
import { hasMasterKey } from "@/src/lib/crypto";

interface LegacyPreset {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  maxIterations?: number;
}

interface LegacyFile {
  presets: LegacyPreset[];
  primaryChatPresetId?: string;
  fallbackChatPresetId?: string;
  primaryEmbeddingPresetId?: string;
  fallbackEmbeddingPresetId?: string;
  activeChatPresetId?: string;
  activeEmbeddingPresetId?: string;
}

export async function seedFromLegacyFile(): Promise<number> {
  const count = await prisma.lLMPreset.count();
  if (count > 0) {
    return 0;
  }

  const filePath = join(
    process.cwd(),
    ".dragnet",
    "llm-presets.json",
  );

  if (!existsSync(filePath)) {
    return 0;
  }

  let parsed: LegacyFile;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[seed] legacy llm-presets.json exists but is unreadable or corrupt — skipping import");
    return 0;
  }

  if (!Array.isArray(parsed.presets) || parsed.presets.length === 0) {
    return 0;
  }

  const canEncrypt = hasMasterKey();
  let imported = 0;
  const primaryChatId = parsed.primaryChatPresetId || parsed.activeChatPresetId || "";
  const primaryEmbedId = parsed.primaryEmbeddingPresetId || parsed.activeEmbeddingPresetId || "";

  for (const p of parsed.presets) {
    let apiKeyCipher: string | null = null;
    let apiKeyIv: string | null = null;
    let apiKeyTag: string | null = null;

    if (p.apiKey && canEncrypt) {
      const encrypted = encryptApiKey(p.apiKey);
      if (encrypted) {
        apiKeyCipher = encrypted.cipher;
        apiKeyIv = encrypted.iv;
        apiKeyTag = encrypted.tag;
      }
    }

    try {
      await prisma.lLMPreset.create({
        data: {
          id: p.id,
          name: p.name,
          endpoint: p.endpoint,
          apiKeyCipher,
          apiKeyIv,
          apiKeyTag,
          chatModel: p.chatModel || "",
          embeddingModel: p.embeddingModel || "",
          maxIterations: p.maxIterations ?? 16,
          isChatPrimary: p.id === primaryChatId,
          isEmbeddingPrimary: p.id === primaryEmbedId,
        },
      });
      imported++;
    } catch (err) {
      console.warn(`[seed] failed to import preset ${p.id}:`, err);
    }
  }

  if (imported > 0) {
    console.log(`[seed] imported ${imported} LLM preset(s) from legacy file`);
  }

  return imported;
}
