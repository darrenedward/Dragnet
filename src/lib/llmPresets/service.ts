import { prisma } from "@/src/lib/prisma";
import type { Preset, PresetsFile, PresetView } from "./types";
import { resolveMaxIterations } from "./types";
import { encryptApiKey, decryptApiKey } from "./crypto";
import { hasMasterKey } from "@/src/lib/crypto";

const CACHE_TTL_MS = 30_000;

interface PresetCache {
  version: number;
  presets: Preset[];
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
  fetchedAt: number;
  loadPromise?: Promise<void>;
}

const g = globalThis as typeof globalThis & {
  __presetCache?: PresetCache;
  __presetCacheVersion?: number;
};

function getCacheVersion(): number {
  return g.__presetCacheVersion ?? 0;
}

export function bumpCacheVersion(): void {
  g.__presetCacheVersion = (getCacheVersion() + 1) % 1_000_000;
}

function rowToPreset(row: {
  id: string;
  name: string;
  endpoint: string;
  apiKeyCipher: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
  chatModel: string;
  embeddingModel: string;
  maxIterations: number;
}): Preset {
  let apiKey = "";
  if (row.apiKeyCipher && row.apiKeyIv && row.apiKeyTag) {
    try {
      apiKey = decryptApiKey(row.apiKeyCipher, row.apiKeyIv, row.apiKeyTag);
    } catch {
      // key unreadable — leave empty
    }
  }
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    apiKey,
    chatModel: row.chatModel,
    embeddingModel: row.embeddingModel,
    maxIterations: row.maxIterations === 16 ? undefined : row.maxIterations,
  };
}

function toView(p: Preset): PresetView {
  return {
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    hasApiKey: Boolean(p.apiKey),
    chatModel: p.chatModel,
    embeddingModel: p.embeddingModel,
    maxIterations: p.maxIterations,
  };
}

async function fetchAllFromDb(): Promise<PresetCache> {
  const rows = await prisma.lLMPreset.findMany();
  const presets = rows.map(rowToPreset);
  const primaryChat = rows.find((r) => r.isChatPrimary);
  const primaryEmbedding = rows.find((r) => r.isEmbeddingPrimary);
  const allIds = new Set(rows.map((r) => r.id));

  const cache: PresetCache = {
    version: getCacheVersion(),
    presets,
    primaryChatPresetId: primaryChat?.id ?? "",
    fallbackChatPresetId: "",
    primaryEmbeddingPresetId: primaryEmbedding?.id ?? "",
    fallbackEmbeddingPresetId: "",
    fetchedAt: Date.now(),
  };

  for (const p of presets) {
    if (p.id !== cache.primaryChatPresetId && allIds.has(p.id)) {
      if (!cache.fallbackChatPresetId) {
        cache.fallbackChatPresetId = p.id;
      }
    }
    if (p.id !== cache.primaryEmbeddingPresetId && allIds.has(p.id)) {
      if (!cache.fallbackEmbeddingPresetId) {
        cache.fallbackEmbeddingPresetId = p.id;
      }
    }
  }

  return cache;
}

function needsRefresh(c: PresetCache | null): boolean {
  if (!c) return true;
  if (c.version !== getCacheVersion()) return true;
  if (Date.now() - c.fetchedAt > CACHE_TTL_MS) return true;
  return false;
}

async function ensureCacheLoaded(): Promise<void> {
  const c = g.__presetCache;
  if (!needsRefresh(c)) return;
  if (c?.loadPromise) {
    await c.loadPromise;
    return;
  }
  const loadPromise = (async () => {
    try {
      const fresh = await fetchAllFromDb();
      g.__presetCache = fresh;
    } catch (err) {
      console.warn("[llmPresets] failed to load cache:", err);
      if (!g.__presetCache) {
        g.__presetCache = {
          version: getCacheVersion(),
          presets: [],
          primaryChatPresetId: "",
          fallbackChatPresetId: "",
          primaryEmbeddingPresetId: "",
          fallbackEmbeddingPresetId: "",
          fetchedAt: Date.now(),
        };
      }
    }
  })();
  if (c) c.loadPromise = loadPromise;
  else g.__presetCache = { version: getCacheVersion(), presets: [], primaryChatPresetId: "", fallbackChatPresetId: "", primaryEmbeddingPresetId: "", fallbackEmbeddingPresetId: "", fetchedAt: 0, loadPromise };
  await loadPromise;
}

function getCached(): PresetCache {
  const c = g.__presetCache;
  if (!c || needsRefresh(c)) {
    void ensureCacheLoaded();
    if (c) return c;
    return {
      version: getCacheVersion(),
      presets: [],
      primaryChatPresetId: "",
      fallbackChatPresetId: "",
      primaryEmbeddingPresetId: "",
      fallbackEmbeddingPresetId: "",
      fetchedAt: Date.now(),
    };
  }
  return c;
}

export function listPresets(): {
  presets: PresetView[];
  activeChatPresetId: string;
  activeEmbeddingPresetId: string;
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
} {
  const c = getCached();
  return {
    presets: c.presets.map(toView),
    activeChatPresetId: c.primaryChatPresetId,
    activeEmbeddingPresetId: c.primaryEmbeddingPresetId,
    primaryChatPresetId: c.primaryChatPresetId,
    fallbackChatPresetId: c.fallbackChatPresetId,
    primaryEmbeddingPresetId: c.primaryEmbeddingPresetId,
    fallbackEmbeddingPresetId: c.fallbackEmbeddingPresetId,
  };
}

export function getPrimaryChatPreset(): Preset | null {
  const c = getCached();
  if (!c.primaryChatPresetId) return null;
  return c.presets.find((p) => p.id === c.primaryChatPresetId) ?? null;
}

export function getPrimaryEmbeddingPreset(): Preset | null {
  const c = getCached();
  if (!c.primaryEmbeddingPresetId) return null;
  return c.presets.find((p) => p.id === c.primaryEmbeddingPresetId) ?? null;
}

export function getFallbackChatPreset(): Preset | null {
  const c = getCached();
  if (!c.fallbackChatPresetId) return null;
  if (c.fallbackChatPresetId === c.primaryChatPresetId) return null;
  return c.presets.find((p) => p.id === c.fallbackChatPresetId) ?? null;
}

export function getFallbackEmbeddingPreset(): Preset | null {
  const c = getCached();
  if (!c.fallbackEmbeddingPresetId) return null;
  if (c.fallbackEmbeddingPresetId === c.primaryEmbeddingPresetId) return null;
  return c.presets.find((p) => p.id === c.fallbackEmbeddingPresetId) ?? null;
}

/** @deprecated Use getPrimaryChatPreset. Alias kept for existing callers. */
export function getActiveChatPreset(): Preset | null {
  return getPrimaryChatPreset();
}

/** @deprecated Use getPrimaryEmbeddingPreset. Alias kept for existing callers. */
export function getActiveEmbeddingPreset(): Preset | null {
  return getPrimaryEmbeddingPreset();
}

function validatePresetsArray(input: unknown): asserts input is {
  presets: Preset[];
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.presets)) throw new Error("`presets` must be an array.");

  const primaryChat =
    typeof obj.primaryChatPresetId === "string"
      ? obj.primaryChatPresetId
      : typeof obj.activeChatPresetId === "string"
        ? obj.activeChatPresetId
        : undefined;
  const primaryEmbedding =
    typeof obj.primaryEmbeddingPresetId === "string"
      ? obj.primaryEmbeddingPresetId
      : typeof obj.activeEmbeddingPresetId === "string"
        ? obj.activeEmbeddingPresetId
        : undefined;
  if (primaryChat === undefined) throw new Error("`primaryChatPresetId` must be a string.");
  if (primaryEmbedding === undefined) throw new Error("`primaryEmbeddingPresetId` must be a string.");

  if (obj.fallbackChatPresetId !== undefined && typeof obj.fallbackChatPresetId !== "string") {
    throw new Error("`fallbackChatPresetId` must be a string when provided.");
  }
  if (obj.fallbackEmbeddingPresetId !== undefined && typeof obj.fallbackEmbeddingPresetId !== "string") {
    throw new Error("`fallbackEmbeddingPresetId` must be a string when provided.");
  }

  const ids = new Set<string>();
  for (const p of obj.presets as unknown[]) {
    if (typeof p !== "object" || p === null) throw new Error("Each preset must be an object.");
    const preset = p as Record<string, unknown>;
    if (typeof preset.id !== "string" || !preset.id) throw new Error("Each preset needs a non-empty id.");
    if (ids.has(preset.id)) throw new Error(`Duplicate preset id: ${preset.id}`);
    ids.add(preset.id);
    if (typeof preset.name !== "string") throw new Error("preset.name must be a string.");
    if (typeof preset.endpoint !== "string") throw new Error("preset.endpoint must be a string.");
    // apiKey may be omitted entirely (undefined) to signal "keep the
    // currently-stored key". An empty string ("") is a deliberate "clear".
    // This three-state contract is what makes the LLM-Settings UX
    // possible — without it, every "Save" without re-pasting the key
    // wipes the stored key and the sidebar shows "No Key".
    if (preset.apiKey !== undefined && typeof preset.apiKey !== "string") {
      throw new Error("preset.apiKey must be a string when provided.");
    }
    if (typeof preset.chatModel !== "string") throw new Error("preset.chatModel must be a string.");
    if (typeof preset.embeddingModel !== "string") throw new Error("preset.embeddingModel must be a string.");
    if (
      preset.maxIterations !== undefined &&
      (typeof preset.maxIterations !== "number" ||
        !Number.isFinite(preset.maxIterations) ||
        preset.maxIterations < 1 ||
        preset.maxIterations > 32)
    ) {
      throw new Error("preset.maxIterations must be between 1 and 32 when provided.");
    }
  }

  if (obj.primaryChatPresetId && !ids.has(obj.primaryChatPresetId as string)) {
    throw new Error(`primaryChatPresetId ${obj.primaryChatPresetId} does not exist in presets.`);
  }
  if (obj.primaryEmbeddingPresetId && !ids.has(obj.primaryEmbeddingPresetId as string)) {
    throw new Error(`primaryEmbeddingPresetId ${obj.primaryEmbeddingPresetId} does not exist in presets.`);
  }
  if (obj.fallbackChatPresetId && !ids.has(obj.fallbackChatPresetId as string)) {
    throw new Error(`fallbackChatPresetId ${obj.fallbackChatPresetId} does not exist in presets.`);
  }
  if (obj.fallbackEmbeddingPresetId && !ids.has(obj.fallbackEmbeddingPresetId as string)) {
    throw new Error(`fallbackEmbeddingPresetId ${obj.fallbackEmbeddingPresetId} does not exist in presets.`);
  }

  (obj as any).primaryChatPresetId = primaryChat;
  (obj as any).primaryEmbeddingPresetId = primaryEmbedding;
  if (obj.fallbackChatPresetId === undefined) (obj as any).fallbackChatPresetId = "";
  if (obj.fallbackEmbeddingPresetId === undefined) (obj as any).fallbackEmbeddingPresetId = "";
}

function needsEncryption(): boolean {
  return hasMasterKey();
}

export async function savePresets(state: PresetsFile): Promise<void> {
  const canEncrypt = needsEncryption();

  await prisma.$transaction(async (tx) => {
    const existing = await tx.lLMPreset.findMany();
    const existingMap = new Map(existing.map((r) => [r.id, r]));
    const incomingIds = new Set(state.presets.map((p) => p.id));

    for (const row of existing) {
      if (!incomingIds.has(row.id)) {
        await tx.lLMPreset.delete({ where: { id: row.id } });
      }
    }

    for (const p of state.presets) {
      const prev = existingMap.get(p.id);
      let apiKeyCipher = prev?.apiKeyCipher ?? null;
      let apiKeyIv = prev?.apiKeyIv ?? null;
      let apiKeyTag = prev?.apiKeyTag ?? null;

      // Three-state contract (matches validatePresetsArray above):
      //   p.apiKey === undefined → keep stored cipher unchanged
      //   p.apiKey === ""        → explicitly clear the key
      //   p.apiKey === "<value>" → rotate to the new value
      if (p.apiKey !== undefined && p.apiKey !== "") {
        if (canEncrypt) {
          const encrypted = encryptApiKey(p.apiKey);
          if (encrypted) {
            apiKeyCipher = encrypted.cipher;
            apiKeyIv = encrypted.iv;
            apiKeyTag = encrypted.tag;
          }
        } else {
          // No master key configured — can't encrypt, refuse to silently
          // drop the value. Caller should set DRAGNET_MASTER_KEY.
          throw new Error(
            `Cannot save key for preset "${p.name}": DRAGNET_MASTER_KEY is not set. ` +
              `Set it in .dragnet/secrets.env or via the UI Install modal before saving keys.`,
          );
        }
      } else if (p.apiKey === "") {
        apiKeyCipher = null;
        apiKeyIv = null;
        apiKeyTag = null;
      }
      // else (undefined) → leave apiKeyCipher/Iv/Tag pointing at prev.'s values.

      await tx.lLMPreset.upsert({
        where: { id: p.id },
        create: {
          id: p.id,
          name: p.name,
          endpoint: p.endpoint,
          apiKeyCipher,
          apiKeyIv,
          apiKeyTag,
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
          maxIterations: p.maxIterations ?? 16,
          isChatPrimary: p.id === state.primaryChatPresetId,
          isEmbeddingPrimary: p.id === state.primaryEmbeddingPresetId,
        },
        update: {
          name: p.name,
          endpoint: p.endpoint,
          apiKeyCipher,
          apiKeyIv,
          apiKeyTag,
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
          maxIterations: p.maxIterations ?? 16,
          isChatPrimary: p.id === state.primaryChatPresetId,
          isEmbeddingPrimary: p.id === state.primaryEmbeddingPresetId,
        },
      });
    }

    const pChat = state.primaryChatPresetId;
    const pEmbed = state.primaryEmbeddingPresetId;
    if (pChat) {
      await tx.lLMPreset.updateMany({
        where: { id: { not: pChat }, isChatPrimary: true },
        data: { isChatPrimary: false },
      });
    }
    if (pEmbed) {
      await tx.lLMPreset.updateMany({
        where: { id: { not: pEmbed }, isEmbeddingPrimary: true },
        data: { isEmbeddingPrimary: false },
      });
    }
  });

  bumpCacheVersion();
  void ensureCacheLoaded();
}

export async function getPreset(id: string): Promise<Preset | null> {
  const row = await prisma.lLMPreset.findUnique({ where: { id } });
  if (!row) return null;
  return rowToPreset(row);
}

export async function getPresetByEndpoint(endpoint: string): Promise<Preset | null> {
  const row = await prisma.lLMPreset.findFirst({ where: { endpoint } });
  if (!row) return null;
  return rowToPreset(row);
}

export async function createPreset(data: {
  name: string;
  endpoint: string;
  apiKey?: string;
  chatModel: string;
  embeddingModel: string;
  maxIterations?: number;
}): Promise<Preset> {
  const canEncrypt = needsEncryption();
  let apiKeyCipher: string | null = null;
  let apiKeyIv: string | null = null;
  let apiKeyTag: string | null = null;

  if (data.apiKey && canEncrypt) {
    const encrypted = encryptApiKey(data.apiKey);
    if (encrypted) {
      apiKeyCipher = encrypted.cipher;
      apiKeyIv = encrypted.iv;
      apiKeyTag = encrypted.tag;
    }
  }

  const row = await prisma.lLMPreset.create({
    data: {
      name: data.name,
      endpoint: data.endpoint,
      apiKeyCipher,
      apiKeyIv,
      apiKeyTag,
      chatModel: data.chatModel,
      embeddingModel: data.embeddingModel,
      maxIterations: data.maxIterations ?? 16,
    },
  });

  bumpCacheVersion();
  void ensureCacheLoaded();
  return rowToPreset(row);
}

export async function updatePreset(
  id: string,
  data: {
    name?: string;
    endpoint?: string;
    apiKey?: string;
    chatModel?: string;
    embeddingModel?: string;
    maxIterations?: number;
  },
): Promise<Preset | null> {
  const existing = await prisma.lLMPreset.findUnique({ where: { id } });
  if (!existing) return null;

  const canEncrypt = needsEncryption();
  let apiKeyCipher = existing.apiKeyCipher;
  let apiKeyIv = existing.apiKeyIv;
  let apiKeyTag = existing.apiKeyTag;

  if (data.apiKey !== undefined) {
    if (data.apiKey && canEncrypt) {
      const encrypted = encryptApiKey(data.apiKey);
      if (encrypted) {
        apiKeyCipher = encrypted.cipher;
        apiKeyIv = encrypted.iv;
        apiKeyTag = encrypted.tag;
      }
    } else if (!data.apiKey) {
      apiKeyCipher = null;
      apiKeyIv = null;
      apiKeyTag = null;
    }
  }

  const row = await prisma.lLMPreset.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.endpoint !== undefined ? { endpoint: data.endpoint } : {}),
      ...(data.chatModel !== undefined ? { chatModel: data.chatModel } : {}),
      ...(data.embeddingModel !== undefined ? { embeddingModel: data.embeddingModel } : {}),
      ...(data.maxIterations !== undefined ? { maxIterations: data.maxIterations } : {}),
      apiKeyCipher,
      apiKeyIv,
      apiKeyTag,
    },
  });

  bumpCacheVersion();
  void ensureCacheLoaded();
  return rowToPreset(row);
}

export async function deletePreset(id: string): Promise<boolean> {
  const existing = await prisma.lLMPreset.findUnique({ where: { id } });
  if (!existing) return false;
  await prisma.lLMPreset.delete({ where: { id } });
  bumpCacheVersion();
  void ensureCacheLoaded();
  return true;
}

export async function setChatPrimary(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.lLMPreset.updateMany({
      where: { isChatPrimary: true },
      data: { isChatPrimary: false },
    });
    await tx.lLMPreset.update({
      where: { id },
      data: { isChatPrimary: true },
    });
  });
  bumpCacheVersion();
  void ensureCacheLoaded();
}

export async function setEmbeddingPrimary(id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.lLMPreset.updateMany({
      where: { isEmbeddingPrimary: true },
      data: { isEmbeddingPrimary: false },
    });
    await tx.lLMPreset.update({
      where: { id },
      data: { isEmbeddingPrimary: true },
    });
  });
  bumpCacheVersion();
  void ensureCacheLoaded();
}

export async function preloadCache(): Promise<void> {
  await ensureCacheLoaded();
}

export { validatePresetsArray as validatePresetsInput };
