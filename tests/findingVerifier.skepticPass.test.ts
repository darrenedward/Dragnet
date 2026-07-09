import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CandidateFinding } from "../src/services/findingVerifier";

/**
 * Skeptic pass tests — adversarial adjudication by the fallback model.
 *
 * The pass lives at src/services/findingVerifier/skepticPass.ts and is
 * invoked from reviewService.ts after verifyFindings completes. It issues
 * a single batched chat completion to the fallback ChainEntry and applies
 * structured verdicts (confirm / downgrade / reject) by id.
 *
 * Mock posture: vi.mock the parent module to stub `loadFileContent`, and
 * build a fake ChainEntry whose `client.chat.completions.create` returns
 * controlled responses.
 */

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-"));
});

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Mock loadFileContent — the skeptic module imports it from the parent.
// vi.hoisted ensures the mock fn exists when vi.mock's factory runs.
const { loadFileContentMock } = vi.hoisted(() => ({
  loadFileContentMock: vi.fn(),
}));
vi.mock("../src/services/findingVerifier", () => ({
  loadFileContent: loadFileContentMock,
}));

// Import after mock is registered.
import { runSkepticPass, stepSeverityDown } from "../src/services/findingVerifier/skepticPass";

function finding(opts: Partial<CandidateFinding> & { id: string }): CandidateFinding {
  return {
    category: "Bug",
    severity: "blocker",
    filename: "src/app/page.tsx",
    line: 10,
    explanation: "This code has a bug.",
    ...opts,
  };
}

function fakeClient(createFn: ReturnType<typeof vi.fn>) {
  return {
    chat: {
      completions: {
        create: createFn,
      },
    },
  } as any;
}

function fallbackEntry(createFn: ReturnType<typeof vi.fn>) {
  return {
    client: fakeClient(createFn),
    model: "minimax/MiniMAX-M1",
    name: "Minimax",
    endpoint: "https://minimax.example.com/v1",
    maxIterations: 4,
  };
}

function llmResponse(content: string) {
  return Promise.resolve({
    choices: [{ message: { content } }],
  });
}

describe("skepticPass — runSkepticPass", () => {
  beforeEach(() => {
    loadFileContentMock.mockReset();
    loadFileContentMock.mockResolvedValue("line1\nline2\nline3\nline4\nline5\n");
  });

  it("returns empty Map on empty candidates (no LLM call)", async () => {
    const createFn = vi.fn();
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass([], entry, tmpDir, "pr-1");
    expect(result.size).toBe(0);
    expect(createFn).not.toHaveBeenCalled();
    cleanup();
  });

  it("applies verdicts when LLM returns valid JSON", async () => {
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        JSON.stringify({
          verdicts: [
            { id: "a", verdict: "confirmed", note: "real issue" },
            {
              id: "b",
              verdict: "downgraded",
              severity: "warning",
              note: "overstated",
            },
            { id: "c", verdict: "rejected", note: "FP" },
          ],
        }),
      ),
    );
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [
        finding({ id: "a" }),
        finding({ id: "b" }),
        finding({ id: "c" }),
      ],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(3);
    expect(result.get("a")?.verdict).toBe("confirmed");
    expect(result.get("a")?.note).toBe("real issue");
    expect(result.get("b")?.verdict).toBe("downgraded");
    expect(result.get("b")?.newSeverity).toBe("warning");
    expect(result.get("c")?.verdict).toBe("rejected");
    cleanup();
  });

  it("returns empty Map on malformed JSON (single warn line, never throws)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createFn = vi.fn().mockImplementation(() => llmResponse("not valid json"));
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(0);
    const parseWarnCalled = warnSpy.mock.calls.some((c) =>
      String(c[0] ?? "").includes("failed to parse JSON verdicts"),
    );
    expect(parseWarnCalled).toBe(true);
    warnSpy.mockRestore();
    cleanup();
  });

  it("discards verdicts with unknown id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        JSON.stringify({
          verdicts: [
            { id: "a", verdict: "confirmed", note: "ok" },
            { id: "unknown-id", verdict: "confirmed", note: "mystery" },
          ],
        }),
      ),
    );
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(1);
    expect(result.has("a")).toBe(true);
    expect(result.has("unknown-id")).toBe(false);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes("discarded 1 invalid verdict"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    cleanup();
  });

  it("discards verdicts with invalid verdict enum", async () => {
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        JSON.stringify({
          verdicts: [
            { id: "a", verdict: "bogus", note: "?" },
            { id: "b", verdict: "confirmed", note: "ok" },
          ],
        }),
      ),
    );
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a" }), finding({ id: "b" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(1);
    expect(result.has("b")).toBe(true);
    expect(result.has("a")).toBe(false);
    cleanup();
  });

  it("keeps downgrade verdict with missing severity (caller steps down)", async () => {
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        JSON.stringify({
          verdicts: [
            { id: "a", verdict: "downgraded", note: "no severity proposed" },
          ],
        }),
      ),
    );
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a", severity: "blocker" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(1);
    const verdict = result.get("a");
    expect(verdict?.verdict).toBe("downgraded");
    expect(verdict?.newSeverity).toBeUndefined();
    cleanup();
  });

  it("truncates batch at 30 findings (overflow gets no verdict)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        JSON.stringify({
          verdicts: Array.from({ length: 30 }, (_, i) => ({
            id: `f${i}`,
            verdict: "confirmed",
            note: "ok",
          })),
        }),
      ),
    );
    const entry = fallbackEntry(createFn);
    const candidates: CandidateFinding[] = Array.from({ length: 35 }, (_, i) =>
      finding({ id: `f${i}` }),
    );
    const result = await runSkepticPass(candidates, entry, tmpDir, "pr-1");
    expect(result.size).toBe(30);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes("truncating batch to 30 of 35"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    cleanup();
  });

  it("never throws — returns empty Map on LLM error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createFn = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("network down")));
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(0);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes("pass failed"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
    cleanup();
  });

  it("strips <think> blocks before parsing JSON", async () => {
    const createFn = vi.fn().mockImplementation(() =>
      llmResponse(
        `<think>reasoning here</think>\n\`\`\`json\n${JSON.stringify({
          verdicts: [{ id: "a", verdict: "confirmed", note: "ok" }],
        })}\n\`\`\``,
      ),
    );
    const entry = fallbackEntry(createFn);
    const result = await runSkepticPass(
      [finding({ id: "a" })],
      entry,
      tmpDir,
      "pr-1",
    );
    expect(result.size).toBe(1);
    expect(result.get("a")?.verdict).toBe("confirmed");
    cleanup();
  });
});

describe("skepticPass — stepSeverityDown", () => {
  it("steps blocker -> warning", () => {
    expect(stepSeverityDown("blocker")).toBe("warning");
  });
  it("steps warning -> suggestion", () => {
    expect(stepSeverityDown("warning")).toBe("suggestion");
  });
  it("floors suggestion", () => {
    expect(stepSeverityDown("suggestion")).toBe("suggestion");
  });
  it("treats unknown severity as already-lowest", () => {
    expect(stepSeverityDown("unknown")).toBe("suggestion");
  });
});
