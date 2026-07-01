/**
 * Provider circuit breaker — tracks per-provider health so repeated
 * quality failures pause a provider for a cooldown window.
 *
 * Phase 3 of the provider-resilience umbrella spec.
 *
 * **Breaker key:** `{provider_host}:{model}`. The host is derived from
 * the preset's `endpoint` URL so two presets pointing at the same
 * upstream (e.g. one named "NVIDIA prod" + one named "NVIDIA test"
 * both hitting `integrate.api.nvidia.com`) share a breaker. Display
 * metadata (preset name) is stored alongside but does not affect keying.
 *
 * **State machine:**
 *
 *   closed     → open       after N consecutive quality_failures
 *   open       → half-open  after cooldown expires (computed on read)
 *   half-open  → closed     on first success (resets counter)
 *   half-open  → open       on first quality_failure (resets cooldown)
 *
 * Transport failures, interruptions, and unknown failures never count.
 * This is critical: a flaky network must not pause a working model.
 *
 * **Persistence:** `<repo.path>/.dragnet/provider-health.json` with
 * atomic write (temp + rename) at mode 0600. Lives under `repo.path`
 * (NOT `process.cwd()`) because the Dragnet server's cwd is its install
 * dir, not the scanned repo — writing there would silently corrupt an
 * unrelated repo's health state and break `/dragnet` skill lookups.
 *
 * **Concurrency:** read-modify-write is approximate. Concurrent scans
 * can race an increment and lose one. This is acceptable: the app
 * already prevents same-PR concurrent scans, and breaker thresholds
 * are heuristic — off-by-one under rare contention is fine. No file
 * locks or DB locks in this phase.
 */

import fs from "node:fs";
import path from "node:path";

export type CircuitState = "closed" | "open" | "half-open";

export interface Health {
  /** Consecutive quality-failure count. Reset to 0 on any success. */
  consecutiveQualityFailures: number;
  /** Epoch ms of last transition to "open". Null when never opened. */
  openedAt: number | null;
  /** Epoch ms when the open cooldown expires → provider becomes half-open. */
  cooldownEndsAt: number | null;
  /** Last computed state. Reads may promote "open" → "half-open" on the fly. */
  state: CircuitState;
  /** Display-only preset name; not part of the breaker key. */
  presetName?: string;
  /** Epoch ms of the last update (for debugging). */
  updatedAt: number;
}

export interface ProviderHealthFile {
  /** Breaker key → health record. Key: `{provider_host}:{model}`. */
  providers: Record<string, Health>;
}

/** Default consecutive quality failures before opening the circuit. */
export const DEFAULT_BREAKER_THRESHOLD = 5;

/** Default cooldown window once the circuit opens. 15 minutes. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Threshold env override. Reads `DRAGNET_BREAKER_THRESHOLD`. Falls
 * back to default when unset, non-numeric, or non-positive.
 */
export function getBreakerThreshold(): number {
  const v = Number(process.env.DRAGNET_BREAKER_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_BREAKER_THRESHOLD;
}

/**
 * Cooldown env override (ms). Reads `DRAGNET_BREAKER_COOLDOWN_MS`.
 * Falls back to default when unset, non-numeric, or non-positive.
 */
export function getBreakerCooldownMs(): number {
  const v = Number(process.env.DRAGNET_BREAKER_COOLDOWN_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_BREAKER_COOLDOWN_MS;
}

/**
 * Compute the breaker key for a preset endpoint + model. Host is
 * extracted via URL parsing; falls back to a regex strip if the
 * endpoint isn't a parseable URL (some OpenAI-compatible servers
 * are configured with just `host:port`). Trailing slash is stripped.
 */
export function breakerKeyFor(endpoint: string, model: string): string {
  let host = "";
  try {
    const u = new URL(endpoint);
    if (u.host) host = u.host;
  } catch {
    // fall through to regex strip
  }
  if (!host) {
    // Non-URL or scheme-less input (e.g. "localhost:8080"): the URL
    // parser either throws or returns an empty host. Strip scheme and
    // take everything before the first slash.
    host = endpoint.replace(/^https?:\/\//, "").split("/")[0] || endpoint;
  }
  return `${host}:${model}`;
}

/**
 * Compute the live state for a health record, accounting for cooldown
 * expiry. An "open" record whose cooldown has elapsed is reported as
 * "half-open" without mutating stored state — the next read will also
 * return half-open until either a success closes it or a quality
 * failure reopens it.
 *
 * Missing records are "closed" — fresh providers start healthy.
 */
export function decideState(health: Health | undefined, now: number): CircuitState {
  if (!health) return "closed";
  if (health.state === "open") {
    if (health.cooldownEndsAt !== null && now >= health.cooldownEndsAt) {
      return "half-open";
    }
    return "open";
  }
  return health.state;
}

function freshHealth(now: number): Health {
  return {
    consecutiveQualityFailures: 0,
    openedAt: null,
    cooldownEndsAt: null,
    state: "closed",
    updatedAt: now,
  };
}

/**
 * Record a quality failure against a health record (pure — does not
 * touch disk). Behavior depends on the live state:
 *
 *   closed     → increment counter; open if it reaches threshold
 *   open       → increment counter; refresh cooldown end (treats
 *                repeated mid-open failures as "still broken" so the
 *                cooldown restarts from the latest failure)
 *   half-open  → reopen immediately, reset cooldown to now + cooldownMs
 *
 * Threshold and cooldown are passed in so callers (and tests) can
 * deterministically override the env-driven defaults.
 */
export function recordQualityFailure(
  health: Health | undefined,
  now: number,
  threshold: number,
  cooldownMs: number,
): Health {
  const current = decideState(health, now);
  const next: Health = health ? { ...health } : freshHealth(now);
  next.updatedAt = now;

  if (current === "half-open") {
    next.state = "open";
    next.openedAt = now;
    next.cooldownEndsAt = now + cooldownMs;
    next.consecutiveQualityFailures = threshold;
    return next;
  }

  next.consecutiveQualityFailures = (health?.consecutiveQualityFailures ?? 0) + 1;
  if (next.consecutiveQualityFailures >= threshold) {
    next.state = "open";
    next.openedAt = now;
    next.cooldownEndsAt = now + cooldownMs;
  }
  return next;
}

/**
 * Record a success against a health record (pure). Any success closes
 * the circuit and resets the counter — whether the provider was
 * closed, open, or half-open. This matches the standard circuit-
 * breaker pattern: a single healthy probe means the provider is back.
 */
export function recordSuccess(health: Health | undefined, now: number): Health {
  const next: Health = health ? { ...health } : freshHealth(now);
  next.updatedAt = now;
  next.state = "closed";
  next.consecutiveQualityFailures = 0;
  next.openedAt = null;
  next.cooldownEndsAt = null;
  return next;
}

/** File path: `<repoPath>/.dragnet/provider-health.json`. */
export function healthFilePath(repoPath: string): string {
  return path.join(repoPath, ".dragnet", "provider-health.json");
}

/**
 * Read the health file. Returns an empty record set on missing file
 * (common — fresh repos have no health state yet) or corrupt JSON
 * (logged at warn; never thrown — caller cannot recover from this
 * failure and we must not block scans on a malformed health file).
 */
export function readHealthFile(repoPath: string): ProviderHealthFile {
  const filePath = healthFilePath(repoPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.providers) {
      return { providers: parsed.providers as Record<string, Health> };
    }
    return { providers: {} };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[providerHealth] failed to read ${filePath}: ${err?.message ?? err}`);
    }
    return { providers: {} };
  }
}

/**
 * Atomic write: mkdir -p, write to `<file>.tmp` at mode 0600, rename.
 * Failures are logged and swallowed — a failed health write must not
 * fail the scan. The temp+rename dance ensures a partial write never
 * appears as the canonical file (concurrent readers see either the
 * old or the new file, never a truncated mix).
 */
export function writeHealthFile(repoPath: string, file: ProviderHealthFile): void {
  const filePath = healthFilePath(repoPath);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err: any) {
    console.warn(`[providerHealth] failed to write ${filePath}: ${err?.message ?? err}`);
  }
}

/**
 * Record a quality failure for `{endpoint, model}` to disk. Reads,
 * mutates, writes. Approximate under concurrent scans — acceptable
 * per the spec (no locks this phase).
 *
 * No-ops and logs when `repoPath` is missing. The Dragnet server's
 * cwd is its install dir, not the scanned repo; never fall back to
 * `process.cwd()` here — that would write health state into the
 * wrong repo and silently corrupt another project's breaker.
 */
export function recordProviderQualityFailure(
  repoPath: string | null | undefined,
  endpoint: string,
  model: string,
  presetName?: string,
): void {
  if (!repoPath) {
    console.warn("[providerHealth] recordQualityFailure skipped: no repoPath");
    return;
  }
  const key = breakerKeyFor(endpoint, model);
  const now = Date.now();
  const file = readHealthFile(repoPath);
  const prev = file.providers[key];
  file.providers[key] = recordQualityFailure(prev, now, getBreakerThreshold(), getBreakerCooldownMs());
  if (presetName) file.providers[key].presetName = presetName;
  writeHealthFile(repoPath, file);
}

/**
 * Record a success for `{endpoint, model}` to disk. Resets the
 * breaker for that key. Same no-repoPath semantics as above.
 */
export function recordProviderSuccess(
  repoPath: string | null | undefined,
  endpoint: string,
  model: string,
  presetName?: string,
): void {
  if (!repoPath) {
    console.warn("[providerHealth] recordSuccess skipped: no repoPath");
    return;
  }
  const key = breakerKeyFor(endpoint, model);
  const now = Date.now();
  const file = readHealthFile(repoPath);
  const prev = file.providers[key];
  file.providers[key] = recordSuccess(prev, now);
  if (presetName) file.providers[key].presetName = presetName;
  writeHealthFile(repoPath, file);
}

/**
 * Returns the live state for `{endpoint, model}`. "closed" when no
 * record exists or repoPath is unavailable (a missing repoPath must
 * never block a scan — provider stays eligible by default).
 */
export function getProviderHealth(
  repoPath: string | null | undefined,
  endpoint: string,
  model: string,
): { state: CircuitState; health: Health | null } {
  if (!repoPath) return { state: "closed", health: null };
  const key = breakerKeyFor(endpoint, model);
  const file = readHealthFile(repoPath);
  const health = file.providers[key] ?? null;
  return { state: decideState(health ?? undefined, Date.now()), health };
}

/**
 * Snapshot every provider's live state. Used by the LLM Settings UI
 * to render health chips. States are computed at read time so an
 * expired "open" correctly shows as "half-open".
 */
export function listProviderHealth(
  repoPath: string | null | undefined,
): ProviderHealthFile {
  if (!repoPath) return { providers: {} };
  return readHealthFile(repoPath);
}

/**
 * Reset breaker state. With no endpoint/model: clears the entire file
 * (used by the "Reset all" button). With both: deletes just that key
 * (used by per-preset "Reset this provider" actions).
 */
export function resetProviderHealth(
  repoPath: string | null | undefined,
  endpoint?: string,
  model?: string,
): void {
  if (!repoPath) return;
  if (!endpoint || !model) {
    writeHealthFile(repoPath, { providers: {} });
    return;
  }
  const key = breakerKeyFor(endpoint, model);
  const file = readHealthFile(repoPath);
  delete file.providers[key];
  writeHealthFile(repoPath, file);
}
