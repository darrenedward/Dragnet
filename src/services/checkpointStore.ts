/**
 * Scan checkpoint store — persists in-flight agentic-loop state so an
 * interrupted scan can resume from the last completed iteration instead
 * of replaying iteration 1 (and repaying token cost).
 *
 * Phase 5 of the provider-resilience umbrella spec.
 *
 * **Layout (centralised):** `<scanStateRoot>/<repoId>/checkpoints/<runId>/<checkpointId>.json`
 *
 * **Layout (legacy):** `<repo.path>/.dragnet/checkpoints/<runId>/<checkpointId>.json`
 *
 * Slice 2: all functions accept an optional `repoId` parameter. When
 * provided, the central scan-state path is used. When omitted, the
 * legacy per-repo `.dragnet/` path is used for back-compat.
 *
 *   - `checkpointId` is `__run` for normal scans, `ReviewChunk.id` for
 *     chunked large-PR scans. Per-chunk ids let a multi-chunk run resume
 *     one chunk without losing the others.
 *
 * **Persistence:** atomic write — `mkdir -p`, write to `<file>.tmp` at
 * mode `0600`, rename. Concurrent readers see either the old or new
 * file, never a truncated mix.
 *
 * **Truncation:** checkpoint files can grow large because tool results
 * (searchCodebase, retrieveFile, etc.) embed code snippets. Before
 * writing, `truncateCheckpointState()` keeps the last two iterations
 * verbatim, preserves all assistant messages, and caps any single
 * tool-result payload at 4KB with a clear truncation marker. This is
 * deterministic so the same input always produces the same sized output.
 *
 * **Concurrency:** read-modify-write is approximate. Same posture as
 * providerHealth.ts — the app already prevents same-PR concurrent scans,
 * and resume is a recovery path, not a hot loop. No file locks.
 */

import fs from "node:fs";
import path from "node:path";
import { getScanStatePath, getLegacyScanStatePath } from "@/src/lib/scanStatePath";

/**
 * Schema version for the on-disk checkpoint format. Bump when the
 * CheckpointState shape changes; resume code can refuse to load
 * mismatched versions instead of guessing at field semantics.
 */
export const CHECKPOINT_FORMAT_VERSION = 1;

/**
 * Hard cap on a single tool-result payload before truncation. 4KB is
 * enough to preserve error messages, file headers, and short snippets
 * while discarding the bulk of large file dumps that the model has
 * already seen and can re-fetch on resume.
 */
export const TOOL_RESULT_PAYLOAD_CAP_BYTES = 4 * 1024;

/**
 * Marker inserted into truncated tool results so the model knows the
 * payload was shortened, not silently dropped. Picked to be unambiguous
 * in JSON and grep-able in logs.
 */
export const TRUNCATION_MARKER = "[truncated by dragnet checkpoint]";

/** Checkpoint id for a normal (non-chunked) scan. */
export const RUN_CHECKPOINT_ID = "__run";

/** A single chat message in the OpenAI-style `{role, content}` shape. */
export interface CheckpointMessage {
  role: string;
  content: unknown;
  // Index signature lets callers spread checkpoint-loaded messages
  // straight into chat.completions.create({ messages }) without a copy,
  // and lets CheckpointMessage satisfy CheckpointMessageLike in
  // reviewService.ts (which mirrors this shape for the runPrScan
  // options). Extra fields like tool_calls/tool_call_id pass through.
  [key: string]: unknown;
}

export interface CheckpointState {
  /** On-disk format version. Resume refuses mismatched versions. */
  version: number;
  /** ReviewRun.id this checkpoint belongs to. */
  runId: string;
  /** `__run` for normal scans, `ReviewChunk.id` for chunked scans. */
  checkpointId: string;
  /** PR commit hash at scan start. Resume rejects on mismatch. */
  commitHash: string;
  /** PR diff hash at scan start. Resume rejects on mismatch. */
  diffHash: string;
  /** Review-config hash (model+prompt+limits). Resume rejects on mismatch. */
  reviewConfigHash: string;
  /** Chat messages accumulated through `loopCount` iterations. */
  messages: CheckpointMessage[];
  /** Iterations completed and persisted. Resume starts at loopCount + 1. */
  loopCount: number;
  /** Max iterations cap from the chat chain entry. */
  maxIterations: number;
  /** Provider endpoint URL — used for breaker key continuity on resume. */
  provider: string;
  /** Model id — used for display + breaker key continuity. */
  model: string;
  /** Epoch ms when this checkpoint was written. */
  writtenAt: number;
}

/**
 * Resolve the base directory for checkpoints. When `repoId` is provided,
 * uses the central scan-state path; otherwise falls back to the legacy
 * `<repoPath>/.dragnet/` path for back-compat.
 */
function checkpointBaseDir(repoPath: string, repoId?: string): string {
  return repoId
    ? path.join(getScanStatePath(repoId), "checkpoints")
    : path.join(getLegacyScanStatePath(repoPath), "checkpoints");
}

/**
 * Build the on-disk path for a checkpoint. Exposed for tests.
 *
 * When `repoId` is provided, resolves under the central scan-state root.
 * When omitted, resolves under `<repoPath>/.dragnet/` (legacy).
 */
export function checkpointFilePath(
  repoPath: string,
  runId: string,
  checkpointId: string,
  repoId?: string,
): string {
  return path.join(checkpointBaseDir(repoPath, repoId), runId, `${checkpointId}.json`);
}

/**
 * Per-run directory. Exposed because `deleteRunCheckpoints` removes it
 * after a successful full run.
 */
export function checkpointRunDir(repoPath: string, runId: string, repoId?: string): string {
  return path.join(checkpointBaseDir(repoPath, repoId), runId);
}

/**
 * Cap a tool-result payload to `TOOL_RESULT_PAYLOAD_CAP_BYTES`. Returns
 * the input unchanged when small enough; otherwise replaces the middle
 * with a truncation marker preserving both head and tail so the model
 * sees the start of the snippet AND the closing context.
 *
 * Works on strings; non-string content is JSON-stringified first.
 */
export function capToolResultPayload(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str =
    typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= TOOL_RESULT_PAYLOAD_CAP_BYTES) return str;
  const keep = Math.floor((TOOL_RESULT_PAYLOAD_CAP_BYTES - TRUNCATION_MARKER.length) / 2);
  return `${str.slice(0, keep)}${TRUNCATION_MARKER}${str.slice(str.length - keep)}`;
}

/**
 * Apply the deterministic truncation rule to a checkpoint state.
 *
 * 1. Walk the message list and rebuild it keeping:
 *    - all assistant messages (small; carry the model's reasoning)
 *    - all system/user messages (small; carry the prompt)
 *    - the last two iterations' tool messages verbatim
 *    - older tool messages with their payload capped at 4KB
 *
 * "Iteration boundary" is the assistant message — each assistant turn
 * ends an iteration, so the last two assistant messages and every
 * tool/user message after the third-from-last assistant are kept whole.
 *
 * This is approximate but deterministic: same input → same output. The
 * goal is bounding file size, not perfect reconstruction of which tool
 * call belongs to which iteration.
 */
export function truncateCheckpointState(state: CheckpointState): CheckpointState {
  if (state.messages.length === 0) return state;

  // Find indexes of assistant messages — iteration boundaries.
  const assistantIdx: number[] = [];
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].role === "assistant") assistantIdx.push(i);
  }

  // Cutoff index: tool messages at or after this index are kept whole.
  // If we have < 3 assistant turns, keep everything from index 0.
  const cutoffIdx =
    assistantIdx.length >= 3
      ? assistantIdx[assistantIdx.length - 2] // last 2 iterations verbatim
      : 0;

  const truncated: CheckpointMessage[] = state.messages.map((msg, idx) => {
    if (msg.role !== "tool") return msg;
    if (idx >= cutoffIdx) return msg;
    // Older tool message — cap payload.
    return {
      role: msg.role,
      content: capToolResultPayload(msg.content),
    };
  });

  return { ...state, messages: truncated };
}

/**
 * Atomic write. mkdir -p the run dir, write to `<file>.tmp` at mode
 * 0600, rename into place. Failures are logged and swallowed — a
 * failed checkpoint write must not fail the scan. Caller already
 * wrapped this in try/catch per Phase 6 contract; this is the second
 * layer of defense.
 */
export function writeCheckpoint(
  repoPath: string,
  runId: string,
  checkpointId: string,
  state: CheckpointState,
  repoId?: string,
): void {
  const filePath = checkpointFilePath(repoPath, runId, checkpointId, repoId);
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prepared = truncateCheckpointState(state);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prepared, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err: any) {
    console.warn(
      `[checkpoint] failed to write ${filePath}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Read a checkpoint. Returns `null` on missing file (common — fresh
 * runs have none yet) or corrupt JSON (logged at warn; never thrown —
 * caller cannot recover from corruption and resume must fall through
 * to a fresh scan).
 *
 * Format mismatch (wrong `version` or missing fields) also returns
 * null: a partially-written or future-version checkpoint is useless
 * for resume, so the route treats it the same as "no checkpoint."
 */
export function readCheckpoint(
  repoPath: string,
  runId: string,
  checkpointId: string,
  repoId?: string,
): CheckpointState | null {
  const filePath = checkpointFilePath(repoPath, runId, checkpointId, repoId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== CHECKPOINT_FORMAT_VERSION) {
      console.warn(
        `[checkpoint] refusing to load ${filePath}: version ${parsed.version} != ${CHECKPOINT_FORMAT_VERSION}`,
      );
      return null;
    }
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.checkpointId !== "string" ||
      !Array.isArray(parsed.messages)
    ) {
      console.warn(`[checkpoint] refusing to load ${filePath}: missing required fields`);
      return null;
    }
    return parsed as CheckpointState;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[checkpoint] failed to read ${filePath}: ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * List every checkpoint file for a run. Returns the parsed state for
 * each valid file; corrupt/missing-version files are skipped silently
 * (the resume route can't act on them anyway). Used by the resume
 * endpoint to pick the most relevant checkpoint and by Start fresh to
 * delete every file in the run dir.
 */
export function listRunCheckpoints(
  repoPath: string,
  runId: string,
  repoId?: string,
): CheckpointState[] {
  const dir = checkpointRunDir(repoPath, runId, repoId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[checkpoint] failed to list ${dir}: ${err?.message ?? err}`);
    }
    return [];
  }
  const out: CheckpointState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const checkpointId = entry.slice(0, -".json".length);
    const state = readCheckpoint(repoPath, runId, checkpointId, repoId);
    if (state) out.push(state);
  }
  return out;
}

/**
 * Delete a single checkpoint file. Best-effort: missing file is a
 * no-op, errors are logged and swallowed. Called after a chunk
 * succeeds so its checkpoint doesn't linger as a false resume target.
 */
export function deleteCheckpoint(
  repoPath: string,
  runId: string,
  checkpointId: string,
  repoId?: string,
): void {
  const filePath = checkpointFilePath(repoPath, runId, checkpointId, repoId);
  try {
    fs.unlinkSync(filePath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[checkpoint] failed to delete ${filePath}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Delete every checkpoint for a run, then the run directory itself.
 * Called on full-run success and on Start fresh. Missing dir is a
 * no-op; per-file errors are logged and swallowed so a single corrupt
 * file doesn't block cleanup of the rest.
 */
export function deleteRunCheckpoints(repoPath: string, runId: string, repoId?: string): void {
  const dir = checkpointRunDir(repoPath, runId, repoId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[checkpoint] failed to list ${dir}: ${err?.message ?? err}`);
    }
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    try {
      fs.unlinkSync(filePath);
    } catch (err: any) {
      console.warn(`[checkpoint] failed to delete ${filePath}: ${err?.message ?? err}`);
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (err: any) {
    console.warn(`[checkpoint] failed to rmdir ${dir}: ${err?.message ?? err}`);
  }
}
