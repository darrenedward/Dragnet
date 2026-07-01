import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECKPOINT_FORMAT_VERSION,
  RUN_CHECKPOINT_ID,
  TOOL_RESULT_PAYLOAD_CAP_BYTES,
  TRUNCATION_MARKER,
  capToolResultPayload,
  checkpointFilePath,
  checkpointRunDir,
  deleteCheckpoint,
  deleteRunCheckpoints,
  listRunCheckpoints,
  readCheckpoint,
  truncateCheckpointState,
  writeCheckpoint,
  type CheckpointState,
} from "../src/services/checkpointStore";

function makeState(overrides: Partial<CheckpointState> = {}): CheckpointState {
  return {
    version: CHECKPOINT_FORMAT_VERSION,
    runId: "run-1",
    checkpointId: RUN_CHECKPOINT_ID,
    commitHash: "abc123",
    diffHash: "def456",
    reviewConfigHash: "cfg789",
    messages: [],
    loopCount: 0,
    maxIterations: 8,
    provider: "https://example.com/v1",
    model: "test-model",
    writtenAt: 1_700_000_000_000,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dragnet-cp-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint paths", () => {
  it("builds nested path under .dragnet/checkpoints/<runId>/<id>.json", () => {
    expect(checkpointFilePath("/r", "run-1", "__run")).toBe(
      path.join("/r", ".dragnet", "checkpoints", "run-1", "__run.json"),
    );
  });

  it("uses ReviewChunk.id verbatim as checkpointId for chunked scans", () => {
    const id = "chunk_abc123";
    expect(checkpointFilePath("/r", "run-1", id)).toBe(
      path.join("/r", ".dragnet", "checkpoints", "run-1", `${id}.json`),
    );
  });

  it("exposes the run directory for cleanup", () => {
    expect(checkpointRunDir("/r", "run-1")).toBe(
      path.join("/r", ".dragnet", "checkpoints", "run-1"),
    );
  });
});

describe("writeCheckpoint / readCheckpoint round trip", () => {
  it("writes a readable file with truncation applied", () => {
    const state = makeState({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "review this" },
        { role: "assistant", content: "thinking..." },
        { role: "tool", content: "x".repeat(10_000) },
      ],
      loopCount: 1,
    });
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, state);

    const back = readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    expect(back).not.toBeNull();
    expect(back!.runId).toBe("run-1");
    expect(back!.checkpointId).toBe(RUN_CHECKPOINT_ID);
    expect(back!.version).toBe(CHECKPOINT_FORMAT_VERSION);
    // Assistant message preserved verbatim.
    expect(back!.messages[2]).toEqual({ role: "assistant", content: "thinking..." });
    // Single assistant turn => cutoffIdx = 0 => tool message kept whole.
    expect(back!.messages[3]).toEqual({ role: "tool", content: "x".repeat(10_000) });
  });

  it("writes at file mode 0600 (owner read/write only)", () => {
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, makeState());
    const filePath = checkpointFilePath(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates nested run directory on demand", () => {
    const runDir = checkpointRunDir(tmpDir, "run-fresh");
    expect(fs.existsSync(runDir)).toBe(false);
    writeCheckpoint(tmpDir, "run-fresh", RUN_CHECKPOINT_ID, makeState({ runId: "run-fresh" }));
    expect(fs.existsSync(runDir)).toBe(true);
  });

  it("preserves assistant + tool messages from the last two iterations verbatim", () => {
    // 4 assistant turns => 4 iterations. cutoffIdx points at the
    // third-to-last assistant (idx 2), so tool messages at idx >= 2
    // are kept whole; earlier ones get capped.
    const bigPayload = "y".repeat(20_000);
    const state = makeState({
      messages: [
        { role: "assistant", content: "iter 1" },
        { role: "tool", content: bigPayload }, // idx 1 — older than cutoff, capped
        { role: "assistant", content: "iter 2" },
        { role: "tool", content: bigPayload }, // idx 3 — older than cutoff, capped
        { role: "assistant", content: "iter 3" }, // cutoff assistant (3rd from last)
        { role: "tool", content: bigPayload }, // idx 5 — at cutoff, verbatim
        { role: "assistant", content: "iter 4" },
        { role: "tool", content: bigPayload }, // idx 7 — last iteration, verbatim
      ],
    });
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, state);
    const back = readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)!;

    // Verbatim: idx 5, 7 still full size
    expect((back.messages[5].content as string).length).toBe(20_000);
    expect((back.messages[7].content as string).length).toBe(20_000);
    // Capped: idx 1, 3 reduced + marker present
    expect((back.messages[1].content as string).length).toBeLessThan(20_000);
    expect((back.messages[1].content as string)).toContain(TRUNCATION_MARKER);
    expect((back.messages[3].content as string)).toContain(TRUNCATION_MARKER);
  });
});

describe("readCheckpoint error handling", () => {
  it("returns null on missing file", () => {
    expect(readCheckpoint(tmpDir, "nope", RUN_CHECKPOINT_ID)).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    const filePath = checkpointFilePath(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not valid json", { mode: 0o600 });
    expect(readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)).toBeNull();
  });

  it("returns null on wrong format version", () => {
    const filePath = checkpointFilePath(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stale = { ...makeState(), version: 999 };
    fs.writeFileSync(filePath, JSON.stringify(stale), { mode: 0o600 });
    expect(readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    const filePath = checkpointFilePath(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: CHECKPOINT_FORMAT_VERSION, runId: "run-1" }),
      { mode: 0o600 },
    );
    expect(readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)).toBeNull();
  });
});

describe("listRunCheckpoints", () => {
  it("returns empty array when run dir does not exist", () => {
    expect(listRunCheckpoints(tmpDir, "no-such-run")).toEqual([]);
  });

  it("lists every valid checkpoint for a run", () => {
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, makeState({ checkpointId: RUN_CHECKPOINT_ID }));
    writeCheckpoint(tmpDir, "run-1", "chunk-a", makeState({ checkpointId: "chunk-a" }));
    writeCheckpoint(tmpDir, "run-1", "chunk-b", makeState({ checkpointId: "chunk-b" }));

    const list = listRunCheckpoints(tmpDir, "run-1");
    expect(list).toHaveLength(3);
    const ids = list.map((c) => c.checkpointId).sort();
    expect(ids).toEqual([RUN_CHECKPOINT_ID, "chunk-a", "chunk-b"].sort());
  });

  it("skips corrupt files and returns only valid ones", () => {
    writeCheckpoint(tmpDir, "run-1", "good", makeState({ checkpointId: "good" }));
    const bad = checkpointFilePath(tmpDir, "run-1", "bad");
    fs.writeFileSync(bad, "{broken", { mode: 0o600 });

    const list = listRunCheckpoints(tmpDir, "run-1");
    expect(list).toHaveLength(1);
    expect(list[0].checkpointId).toBe("good");
  });

  it("ignores non-json files in the run dir", () => {
    writeCheckpoint(tmpDir, "run-1", "good", makeState({ checkpointId: "good" }));
    fs.writeFileSync(
      path.join(checkpointRunDir(tmpDir, "run-1"), "notes.txt"),
      "ignore me",
      { mode: 0o600 },
    );
    expect(listRunCheckpoints(tmpDir, "run-1")).toHaveLength(1);
  });
});

describe("deleteCheckpoint", () => {
  it("removes a single checkpoint file", () => {
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, makeState());
    expect(readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)).not.toBeNull();
    deleteCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID);
    expect(readCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID)).toBeNull();
  });

  it("is a no-op on missing file", () => {
    expect(() => deleteCheckpoint(tmpDir, "run-1", "never-existed")).not.toThrow();
  });
});

describe("deleteRunCheckpoints", () => {
  it("removes every checkpoint file for a run and the run dir", () => {
    writeCheckpoint(tmpDir, "run-1", RUN_CHECKPOINT_ID, makeState());
    writeCheckpoint(tmpDir, "run-1", "chunk-a", makeState({ checkpointId: "chunk-a" }));
    writeCheckpoint(tmpDir, "run-1", "chunk-b", makeState({ checkpointId: "chunk-b" }));

    deleteRunCheckpoints(tmpDir, "run-1");

    expect(listRunCheckpoints(tmpDir, "run-1")).toEqual([]);
    expect(fs.existsSync(checkpointRunDir(tmpDir, "run-1"))).toBe(false);
  });

  it("is a no-op when the run dir does not exist", () => {
    expect(() => deleteRunCheckpoints(tmpDir, "no-such-run")).not.toThrow();
  });
});

describe("capToolResultPayload", () => {
  it("returns short strings unchanged", () => {
    expect(capToolResultPayload("short")).toBe("short");
  });

  it("caps long strings with marker in the middle", () => {
    const huge = "z".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 3);
    const out = capToolResultPayload(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain(TRUNCATION_MARKER);
    // Both head and tail preserved.
    expect(out.startsWith("zzz")).toBe(true);
    expect(out.endsWith("zzz")).toBe(true);
  });

  it("JSON-stringifies non-string input before capping", () => {
    const obj = { code: "x".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 2) };
    const out = capToolResultPayload(obj);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out).toContain('"code"');
  });

  it("returns empty string for null/undefined", () => {
    expect(capToolResultPayload(null)).toBe("");
    expect(capToolResultPayload(undefined)).toBe("");
  });
});

describe("truncateCheckpointState", () => {
  it("preserves non-tool messages verbatim regardless of position", () => {
    const state = makeState({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 5) },
      ],
    });
    const out = truncateCheckpointState(state);
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages[2]).toEqual({
      role: "assistant",
      content: "a".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 5),
    });
  });

  it("returns state unchanged when messages is empty", () => {
    const state = makeState({ messages: [] });
    expect(truncateCheckpointState(state)).toEqual(state);
  });

  it("does not mutate the input state", () => {
    const original = makeState({
      messages: [
        { role: "assistant", content: "iter 1" },
        { role: "tool", content: "x".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 5) },
        { role: "assistant", content: "iter 2" },
        { role: "tool", content: "x".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 5) },
        { role: "assistant", content: "iter 3" },
        { role: "tool", content: "x".repeat(TOOL_RESULT_PAYLOAD_CAP_BYTES * 5) },
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(original));
    truncateCheckpointState(original);
    expect(JSON.parse(JSON.stringify(original))).toEqual(snapshot);
  });
});
