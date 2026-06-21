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
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
}

export interface PresetsFile {
  presets: Preset[];
  activeChatPresetId: string;
  activeEmbeddingPresetId: string;
}

const PRESETS_DIR = join(process.cwd(), ".greploop");
const PRESETS_PATH = join(PRESETS_DIR, "llm-presets.json");
const PRESETS_TMP = join(PRESETS_DIR, "llm-presets.json.tmp");
const PRESETS_BAK = join(PRESETS_DIR, "llm-presets.json.bak");

const ENV_LOCAL_PATH = join(process.cwd(), ".env.local");

let migrationDone = false;

function emptyState(): PresetsFile {
  return { presets: [], activeChatPresetId: "", activeEmbeddingPresetId: "" };
}

function parseFile(path: string): PresetsFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed.presets) &&
      typeof parsed.activeChatPresetId === "string" &&
      typeof parsed.activeEmbeddingPresetId === "string"
    ) {
      return parsed as PresetsFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads the presets file synchronously (file is ~2KB, sub-ms).
 * Falls back to `.bak` if the main file is missing or corrupt.
 * Returns an empty state only if neither exists.
 */
export function readPresets(): PresetsFile {
  const main = existsSync(PRESETS_PATH) ? parseFile(PRESETS_PATH) : null;
  if (main) return main;

  const bak = existsSync(PRESETS_BAK) ? parseFile(PRESETS_BAK) : null;
  if (bak) {
    console.warn("[llmPresets] main file unreadable, falling back to .bak");
    return bak;
  }

  return emptyState();
}

function toView(p: Preset): PresetView {
  return {
    id: p.id,
    name: p.name,
    endpoint: p.endpoint,
    hasApiKey: Boolean(p.apiKey),
    chatModel: p.chatModel,
    embeddingModel: p.embeddingModel,
  };
}

/**
 * Returns the full state with apiKeys masked. Safe to return to the client.
 */
export function listPresets(): {
  presets: PresetView[];
  activeChatPresetId: string;
  activeEmbeddingPresetId: string;
} {
  ensureMigrated();
  const state = readPresets();
  return {
    presets: state.presets.map(toView),
    activeChatPresetId: state.activeChatPresetId,
    activeEmbeddingPresetId: state.activeEmbeddingPresetId,
  };
}

/**
 * Returns the full preset (including apiKey) for the active chat slot.
 * Server-side only — never return this object to the client.
 */
export function getActiveChatPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.activeChatPresetId) return null;
  return state.presets.find((p) => p.id === state.activeChatPresetId) || null;
}

export function getActiveEmbeddingPreset(): Preset | null {
  ensureMigrated();
  const state = readPresets();
  if (!state.activeEmbeddingPresetId) return null;
  return state.presets.find((p) => p.id === state.activeEmbeddingPresetId) || null;
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
    activeChatPresetId: chatModel ? id : "",
    activeEmbeddingPresetId: embeddingModel ? id : "",
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
 */
export function validatePresetsInput(input: unknown): asserts input is PresetsFile {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected an object body.");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.presets)) throw new Error("`presets` must be an array.");
  if (typeof obj.activeChatPresetId !== "string") throw new Error("`activeChatPresetId` must be a string.");
  if (typeof obj.activeEmbeddingPresetId !== "string") throw new Error("`activeEmbeddingPresetId` must be a string.");

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

  if (obj.activeChatPresetId && !ids.has(obj.activeChatPresetId)) {
    throw new Error(`activeChatPresetId ${obj.activeChatPresetId} does not exist in presets.`);
  }
  if (obj.activeEmbeddingPresetId && !ids.has(obj.activeEmbeddingPresetId)) {
    throw new Error(`activeEmbeddingPresetId ${obj.activeEmbeddingPresetId} does not exist in presets.`);
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
