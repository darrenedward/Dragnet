import { describe, expect, it } from "vitest";
import { getChunkCoverage, isTerminalChunkStatus } from "../src/lib/chunkCoverage";

describe("chunk coverage", () => {
  it("counts only completed, failed, and skipped chunks as terminal", () => {
    expect(isTerminalChunkStatus("completed")).toBe(true);
    expect(isTerminalChunkStatus("failed")).toBe(true);
    expect(isTerminalChunkStatus("skipped")).toBe(true);
    expect(isTerminalChunkStatus("pending")).toBe(false);
    expect(isTerminalChunkStatus("running")).toBe(false);
    expect(isTerminalChunkStatus("interrupted")).toBe(false);
  });

  it("reports incomplete coverage instead of treating pending chunks as success", () => {
    expect(getChunkCoverage([
      { status: "completed" },
      { status: "completed" },
      { status: "pending" },
      { status: "running" },
      { status: "interrupted" },
      { status: "failed" },
      { status: "skipped" },
    ])).toEqual({
      chunksTotal: 7,
      chunksCompleted: 2,
      chunksFailed: 1,
      chunksSkipped: 1,
      chunksIncomplete: 3,
    });
  });
});
