import { chmod, copyFile, rename, writeFile, mkdir, access, constants } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Multi-provider LLM preset storage.
 *
 * Source of truth is `.greploop/llm-presets.json` at the project root.
 * One chat preset and one embedding preset can be independently active,
 * so the user can run e.g. OpenRouter for chat + local Ollama for
 * embeddings against different endpoints/keys.
 *
 * Why a JSON file vs env vars or DB:
 *  - env vars are single-valued (can't hold an array of presets)
 *  - DB adds a network hop without security benefit for single-user dev
 *  - JSON file is easy to inspect/back up, plays nicely with chmod 600
 *
 * Atomicity:
 *  - Writes go to `llm-presets.json.tmp` then `rename` to final
 *  - Before each save, the previous file is copied to `llm-presets.json.bak`
 *    so a corrupt read can fall back
 *
 * Permissions:
 *  - `writeFile(..., { mode: 0o600 })` on first create
 *  - Re-`chmod 0o600` after every write (covers cases where an editor
 *    or git restore reset the mode)
 */

export interface Preset {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
}

export interface PresetView {
  id: string;
  name: string;
  endpoint: string;
  /**
   * Always empty in API responses — never populated by toView(). Kept
   * optional on the type so legacy UI clients that read preset.apiKey
   * don't crash (they get undefined, which falsy-checks the same way).
   */
  apiKey?: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
}

export interface PresetsFile {
  presets: Preset[];
  /**
   * Primary chat preset (was `activeChatPresetId`). Used first for reviews.
   * Old field name still readable for backward compat — see parseFile().
   */
  primaryChatPresetId: string;
  /** Backup chat preset. Tried when primary fails. Empty/null = no fallback. */
  fallbackChatPresetId: string;
  /** Primary embedding preset (was `activeEmbeddingPresetId`). */
  primaryEmbeddingPresetId: string;
  /** Backup embedding preset. Tried when primary fails. Empty/null = no fallback. */
  fallbackEmbeddingPresetId: string;
}

const PRESETS_DIR = join(/* turbopackIgnore: true */ process.cwd(), ".greploop");
const PRESETS_PATH = join(PRESETS_DIR, "llm-presets.json");
const PRESETS_TMP = join(PRESETS_DIR, "llm-presets.json.tmp");
const PRESETS_BAK = join(PRESETS_DIR, "llm-presets.json.bak");

const ENV_LOCAL_PATH = join(/* turbopackIgnore: true */ process.cwd(), ".env.local");

let migrationDone = false;

function emptyState(): PresetsFile {
  return {
    presets: [],
    primaryChatPresetId: "",
    fallbackChatPresetId: "",
    primaryEmbeddingPresetId: "",
    fallbackEmbeddingPresetId: "",
  };
}

/**
 * Normalizes a raw parsed object into the current PresetsFile shape.
 *
 * Backward compat: files written before multi-provider fallback used
 * `activeChatPresetId` / `activeEmbeddingPresetId`. We copy those across
 * to the new `primaryChatPresetId` / `primaryEmbeddingPresetId` fields
 * and default the fallbacks to empty. The normalized shape is returned
 * in memory and persisted by the caller via `scheduleBackCompatWrite`.
 */
function normalizeParsed(parsed: any): PresetsFile | null {
  if (!parsed || !Array.isArray(parsed.presets)) return null;

  const primaryChat =
    typeof parsed.primaryChatPresetId === "string"
      ? parsed.primaryChatPresetId
      : typeof parsed.activeChatPresetId === "string"
        ? parsed.activeChatPresetId
        : "";
  const primaryEmbedding =
    typeof parsed.primaryEmbeddingPresetId === "string"
      ? parsed.primaryEmbeddingPresetId
      : typeof parsed.activeEmbeddingPresetId === "string"
        ? parsed.activeEmbeddingPresetId
        : "";

  return {
    presets: parsed.presets,
    primaryChatPresetId: primaryChat,
    fallbackChatPresetId:
      typeof parsed.fallbackChatPresetId === "string" ? parsed.fallbackChatPresetId : "",
    primaryEmbeddingPresetId: primaryEmbedding,
    fallbackEmbeddingPresetId:
      typeof parsed.fallbackEmbeddingPresetId === "string" ? parsed.fallbackEmbeddingPresetId : "",
  };
}

function parseFile(path: string): PresetsFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeParsed(parsed);
  } catch {
    return null;
  }
}

/**
 * One-shot guard for the `.bak` fallback warning. The indexing/polling
 * services can call readPresets() dozens of times per session — without
 * this guard, a single corrupt main file spams the dev log. The warning
 * fires once per process so the operator sees that something's wrong,
 * then we fall back silently until restart.
 */
let warnedAboutBakFallback = false;

/**
 * Reads the presets file synchronously (file is ~2KB, sub-ms).
 * Falls back to `.bak` if the main file is missing or corrupt.
 * Returns an empty state only if neither exists.
 *
 * Backward compat: if the file uses the legacy `activeChatPresetId` /
 * `activeEmbeddingPresetId` field names, the normalized new-shape state
 * is persisted back to disk asynchronously so future reads skip the
 * migration. The in-memory return always reflects the new shape.
 */
export function readPresets(): PresetsFile {
  const main = existsSync(PRESETS_PATH) ? parseFile(PRESETS_PATH) : null;
  if (main) {
    maybeMigrateLegacyFields(main);
    return main;
  }

  const bak = existsSync(PRESETS_BAK) ? parseFile(PRESETS_BAK) : null;
  if (bak) {
    if (!warnedAboutBakFallback) {
      console.warn("[llmPresets] main file unreadable, falling back to .bak. This warning fires once per process; fix the main file and restart to clear.");
      warnedAboutBakFallback = true;
    }
    maybeMigrateLegacyFields(bak);
    return bak;
  }

  return emptyState();
}

/**
 * If the parsed file still carries legacy field names, persist the
 * normalized new-shape back to disk. Fire-and-forget — the in-memory
 * state already reflects the new shape regardless.
 */
function maybeMigrateLegacyFields(state: PresetsFile): void {
  try {
    const raw = existsSync(PRESETS_PATH) ? readFileSync(PRESETS_PATH, "utf8") : "";
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return;
    const hasLegacy =
      "activeChatPresetId" in parsed || "activeEmbeddingPresetId" in parsed;
    const hasNewPrimary =
      "primaryChatPresetId" in parsed || "primaryEmbeddingPresetId" in parsed;
    if (!hasLegacy || hasNewPrimary) return;

    // Strip legacy keys and persist new shape.
    const next: any = {
      presets: state.presets,
      primaryChatPresetId: state.primaryChatPresetId,
      fallbackChatPresetId: state.fallbackChatPresetId,
      primaryEmbeddingPresetId: state.primaryEmbeddingPresetId,
      fallbackEmbeddingPresetId: state.fallbackEmbeddingPresetId,
    };
    void savePresets(next)
      .then(() => console.log("[llmPresets] migrated legacy active* fields to primary*"))
      .catch((err) => console.warn("[llmPresets] legacy-field migration failed:", err));
  } catch {
    // ignore — non-fatal
  }
}

function toView(p: Preset): PresetView {
  return {
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    // apiKey intentionally NOT returned — never expose provider keys to
    // the browser. UI uses hasApiKey to indicate "key on file". The
    // /api/llm/models route looks up the stored key by endpoint when
    // the user clicks Fetch Models, so re-entering the key isn't needed.
    // To replace a key, the user enters a new value in the input.
    hasApiKey: Boolean(p.apiKey),
    chatModel: p.chatModel,
    embeddingModel: p.embeddingModel,
  };
}

/**
 * Returns the state WITHOUT apiKeys — UI uses hasApiKey to render
 * placeholder text. Keys are written via the presets POST route (which
 * preserves existing values when the client submits an empty string)
 * and read server-side via readPresets() (which sees the full shape).
 *
 * For backward compat with older UI clients, also exposes the legacy
 * `activeChatPresetId`/`activeEmbeddingPresetId` keys mirroring the
 * primary slots.
 */
export function listPresets(): {
  presets: PresetView[];
  activeChatPresetId: string;
  activeEmbeddingPresetId: string;
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
} {
  ensureMigrated();
  const state = readPresets();
  return {
    presets: state.presets.map(toView),
    activeChatPresetId: state.primaryChatPresetId,
    activeEmbeddingPresetId: state.primaryEmbeddingPresetId,
    primaryChatPresetId: state.primaryChatPresetId,
    fallbackChatPresetId: state.fallbackChatPresetId,
    primaryEmbeddingPresetId: state.primaryEmbeddingPresetId,
    fallbackEmbeddingPresetId: state.fallbackEmbeddingPresetId,
  };
}

/**
 * Returns the full preset (including apiKey) for the primary chat slot.
 * Server-side only — never return this object to the client.
 *
 * (Was `getActiveChatPreset` in single-provider era — same semantics,
 * the "active" slot is now the "primary" slot.)
 */
export function getPrimaryChatPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.primaryChatPresetId) return null;
  return state.presets.find((p) => p.id === state.primaryChatPresetId) || null;
}

export function getPrimaryEmbeddingPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.primaryEmbeddingPresetId) return null;
  return state.presets.find((p) => p.id === state.primaryEmbeddingPresetId) || null;
}

/**
 * Backup chat preset. Null when unconfigured or points at a missing preset.
 */
export function getFallbackChatPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.fallbackChatPresetId) return null;
  if (state.fallbackChatPresetId === state.primaryChatPresetId) return null;
  return state.presets.find((p) => p.id === state.fallbackChatPresetId) || null;
}

export function getFallbackEmbeddingPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.fallbackEmbeddingPresetId) return null;
  if (state.fallbackEmbeddingPresetId === state.primaryEmbeddingPresetId) return null;
  return state.presets.find((p) => p.id === state.fallbackEmbeddingPresetId) || null;
}

/** @deprecated Use getPrimaryChatPreset. Alias kept for existing callers. */
export function getActiveChatPreset(): Preset | null {
  return getPrimaryChatPreset();
}

/** @deprecated Use getPrimaryEmbeddingPreset. Alias kept for existing callers. */
export function getActiveEmbeddingPreset(): Preset | null {
  return getPrimaryEmbeddingPreset();
}

/**
 * Stable hash of apiKey for cache keying. We never log this; it exists
 * only so the cached OpenAI client can be invalidated when the user
 * edits a preset's key without changing its id.
 */
export function apiKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * Atomic write: tmp file → rename. Existing file is backed up to .bak
 * first. File mode is reset to 0o600 after every write to survive
 * editor/git-restore resets.
 */
export async function savePresets(state: PresetsFile): Promise<void> {
  await mkdir(PRESETS_DIR, { recursive: true });

  if (existsSync(PRESETS_PATH)) {
    try {
      await copyFile(PRESETS_PATH, PRESETS_BAK);
    } catch (err) {
      console.warn("[llmPresets] failed to write .bak (continuing):", err);
    }
  }

  const payload = JSON.stringify(state, null, 2);
  await writeFile(PRESETS_TMP, payload, { mode: 0o600 });
  await rename(PRESETS_TMP, PRESETS_PATH);
  await chmod(PRESETS_PATH, 0o600);
}

/**
 * One-shot migration from .env.local LLM_* values to a single preset.
 * Idempotent — no-op once `.greploop/llm-presets.json` exists.
 *
 * Reads `.env.local` directly from disk (NOT process.env) because
 * process.env holds values from boot time and can be stale if the
 * user edited the file without restarting.
 */
export function migrateFromEnvLocalIfNeeded(): void {
  if (migrationDone) return;
  migrationDone = true;

  if (existsSync(PRESETS_PATH)) return;

  let envText = "";
  try {
    envText = readFileSync(ENV_LOCAL_PATH, "utf8");
  } catch {
    return;
  }

  const getVar = (name: string): string => {
    const re = new RegExp(`^${name}="(.*)"$`, "m");
    const m = envText.match(re);
    return m ? m[1] : "";
  };

  const endpoint = getVar("LLM_ENDPOINT");
  const apiKey = getVar("LLM_API_KEY");
  const chatModel = getVar("LLM_MODEL");
  const embeddingModel = getVar("LLM_EMBEDDING_MODEL");

  if (!endpoint && !apiKey && !chatModel && !embeddingModel) return;

  const id = `preset-migrated-${Date.now()}`;
  const preset: Preset = {
    id,
    name: "Migrated",
    endpoint: endpoint || "https://openrouter.ai/api/v1",
    apiKey,
    chatModel,
    embeddingModel,
  };

  const state: PresetsFile = {
    presets: [preset],
    primaryChatPresetId: chatModel ? id : "",
    fallbackChatPresetId: "",
    primaryEmbeddingPresetId: embeddingModel ? id : "",
    fallbackEmbeddingPresetId: "",
  };

  void savePresets(state)
    .then(() => {
      console.log("[llmPresets] migrated LLM_* from .env.local into preset", id);
    })
    .catch((err) => {
      console.warn("[llmPresets] migration failed:", err);
    });
}

function ensureMigrated(): void {
  if (!migrationDone) migrateFromEnvLocalIfNeeded();
}

/**
 * Validation pass for incoming PUT bodies. Throws on invalid input.
 * Used by the API route so client-side bugs can't corrupt the file.
 *
 * Accepts either the new primary/fallback shape or the legacy active-only
 * shape. Legacy inputs are normalized in-memory to the new shape.
 */
export function validatePresetsInput(input: unknown): asserts input is PresetsFile {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.presets)) throw new Error("`presets` must be an array.");

  // Tolerate either old or new field names for primary slots.
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
  obj.primaryChatPresetId = primaryChat;
  obj.primaryEmbeddingPresetId = primaryEmbedding;

  if (obj.fallbackChatPresetId !== undefined && typeof obj.fallbackChatPresetId !== "string") {
    throw new Error("`fallbackChatPresetId` must be a string when provided.");
  }
  if (obj.fallbackEmbeddingPresetId !== undefined && typeof obj.fallbackEmbeddingPresetId !== "string") {
    throw new Error("`fallbackEmbeddingPresetId` must be a string when provided.");
  }
  if (obj.fallbackChatPresetId === undefined) obj.fallbackChatPresetId = "";
  if (obj.fallbackEmbeddingPresetId === undefined) obj.fallbackEmbeddingPresetId = "";

  const ids = new Set<string>();
  for (const p of obj.presets as unknown[]) {
    if (typeof p !== "object" || p === null) throw new Error("Each preset must be an object.");
    const preset = p as Record<string, unknown>;
    if (typeof preset.id !== "string" || !preset.id) throw new Error("Each preset needs a non-empty id.");
    if (ids.has(preset.id)) throw new Error(`Duplicate preset id: ${preset.id}`);
    ids.add(preset.id);
    if (typeof preset.name !== "string") throw new Error("preset.name must be a string.");
    if (typeof preset.endpoint !== "string") throw new Error("preset.endpoint must be a string.");
    if (typeof preset.apiKey !== "string") throw new Error("preset.apiKey must be a string.");
    if (typeof preset.chatModel !== "string") throw new Error("preset.chatModel must be a string.");
    if (typeof preset.embeddingModel !== "string") throw new Error("preset.embeddingModel must be a string.");
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
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export const PRESETS_FILE_PATH = PRESETS_PATH;

export interface RemoteModel {
  id: string;
  name?: string;
}

export interface RemoteModelsResult {
  ok: boolean;
  count?: number;
  models?: RemoteModel[];
  error?: string;
}

/**
 * Fetches the model catalog from an OpenAI-compatible /v1/models endpoint.
 * Doubles as the connection test — a 200 response means the endpoint is
 * reachable and the key is valid. AbortController caps the wait at 8s.
 *
 * Local endpoints (localhost / 127.0.0.1 / 0.0.0.0) skip the apiKey
 * requirement so Ollama and other self-hosted servers work with a blank
 * key. A dummy Bearer is still sent because some OpenAI-compatible
 * proxies 401 on a missing Authorization header.
 */
export async function fetchRemoteModels(
  endpoint: string,
  apiKey: string,
): Promise<RemoteModelsResult> {
  if (!endpoint) return { ok: false, error: "Endpoint URL is required." };

  const isLocal = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(endpoint);
  if (!apiKey && !isLocal) {
    return { ok: false, error: "API key is required for this endpoint." };
  }

  try {
    const url = `${endpoint.replace(/\/$/, "")}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey || "no-key-required"}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Endpoint returned ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    const raw: any[] = data.data || data.models || [];
    const models: RemoteModel[] = raw
      .map((m: any) => ({
        id: typeof m.id === "string" ? m.id : typeof m.name === "string" ? m.name : "",
        name: typeof m.name === "string" ? m.name : undefined,
      }))
      .filter((m) => m.id.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    return { ok: true, count: models.length, models };
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? "Timed out after 8s waiting for endpoint response."
      : e?.message || String(e);
    return { ok: false, error: msg };
  }
}
