import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LOG_VERBOSITY,
  LOG_VERBOSITY_LEVELS,
  clearLogVerbosityCache,
  coerceLogVerbosity,
  isLogLineVisible,
  lineLevelRank,
  readLogVerbosity,
  saveLogVerbosity,
  shouldEmitLog,
  verbosityRank,
  type LogLineLevel,
  type LogVerbosity,
} from "../src/lib/logVerbosity";
import { validateLogVerbosity } from "../src/lib/logVerbosityValidation";

describe("log verbosity filter matrix", () => {
  const levels: LogVerbosity[] = ["debug", "user", "warn", "error"];

  it("exposes User / Warn / Error / Debug with default User", () => {
    expect(LOG_VERBOSITY_LEVELS).toEqual(["user", "warn", "error", "debug"]);
    expect(DEFAULT_LOG_VERBOSITY).toBe("user");
  });

  it("ranks minimum levels so Debug is most verbose and Error least", () => {
    expect(verbosityRank("debug")).toBeLessThan(verbosityRank("user"));
    expect(verbosityRank("user")).toBeLessThan(verbosityRank("warn"));
    expect(verbosityRank("warn")).toBeLessThan(verbosityRank("error"));
  });

  it("maps review-log line levels: tool_call→debug, info→user", () => {
    expect(lineLevelRank("tool_call")).toBe(lineLevelRank("debug"));
    expect(lineLevelRank("info")).toBe(lineLevelRank("user"));
    expect(lineLevelRank("warn")).toBe(verbosityRank("warn"));
    expect(lineLevelRank("error")).toBe(verbosityRank("error"));
  });

  /**
   * Representative lines from server console + in-app ReviewLog.
   * Matrix: at setting S, line L is visible iff rank(L) >= rank(S).
   */
  const representative: Array<{ level: LogLineLevel; sample: string }> = [
    { level: "debug", sample: "[scan] getRealPrs: repoId=abc mode=remote-volume" },
    { level: "tool_call", sample: "Tool: searchCode → 3 hits" },
    { level: "info", sample: "Scan started — 4 file(s) to review" },
    { level: "user", sample: "Review complete — 2 finding(s), rating 8/10" },
    { level: "warn", sample: "Loop exhausted — no submitReview after 8 iterations" },
    { level: "error", sample: "Provider openai failed: 429 rate limit" },
  ];

  it.each(levels)("filter matrix at minLevel=%s for representative lines", (min) => {
    for (const line of representative) {
      const expected = lineLevelRank(line.level) >= verbosityRank(min);
      expect(shouldEmitLog(min, line.level), `${line.sample} @ ${min}`).toBe(expected);
      expect(isLogLineVisible(min, line.level)).toBe(expected);
    }
  });

  it("at User, routine PR-list poll (debug) is hidden; info/warn/error stay", () => {
    expect(shouldEmitLog("user", "debug")).toBe(false);
    expect(shouldEmitLog("user", "tool_call")).toBe(false);
    expect(shouldEmitLog("user", "info")).toBe(true);
    expect(shouldEmitLog("user", "warn")).toBe(true);
    expect(shouldEmitLog("user", "error")).toBe(true);
  });

  it("at Debug, diagnostic detail including polls/tool noise is available", () => {
    expect(shouldEmitLog("debug", "debug")).toBe(true);
    expect(shouldEmitLog("debug", "tool_call")).toBe(true);
    expect(shouldEmitLog("debug", "info")).toBe(true);
  });

  it("at Warn, only warn+error; at Error, only error", () => {
    expect(shouldEmitLog("warn", "info")).toBe(false);
    expect(shouldEmitLog("warn", "warn")).toBe(true);
    expect(shouldEmitLog("error", "warn")).toBe(false);
    expect(shouldEmitLog("error", "error")).toBe(true);
  });

  it("unknown line levels are treated as user/info (visible at User)", () => {
    expect(shouldEmitLog("user", "mystery" as LogLineLevel)).toBe(true);
    expect(shouldEmitLog("warn", "mystery" as LogLineLevel)).toBe(false);
  });
});

describe("coerceLogVerbosity / validateLogVerbosity", () => {
  it("coerces valid strings case-insensitively", () => {
    expect(coerceLogVerbosity("User")).toBe("user");
    expect(coerceLogVerbosity("DEBUG")).toBe("debug");
    expect(coerceLogVerbosity("warn")).toBe("warn");
  });

  it("returns null for invalid values", () => {
    expect(coerceLogVerbosity("trace")).toBeNull();
    expect(coerceLogVerbosity(1)).toBeNull();
    expect(coerceLogVerbosity(null)).toBeNull();
  });

  it("validateLogVerbosity accepts body.level and rejects bad input", () => {
    expect(validateLogVerbosity({ level: "debug" })).toEqual({ level: "debug" });
    expect(validateLogVerbosity({ level: "user" })).toEqual({ level: "user" });
    expect(() => validateLogVerbosity({})).toThrow(/level/);
    expect(() => validateLogVerbosity({ level: "trace" })).toThrow(/level/);
    expect(() => validateLogVerbosity(null)).toThrow(/object/);
  });
});

describe("logVerbosity settings store", () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "dragnet-log-verbosity-"));
    process.chdir(tempRoot);
    clearLogVerbosityCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    clearLogVerbosityCache();
  });

  it("returns default User when no file exists and does not write on read", () => {
    expect(readLogVerbosity()).toEqual({ level: "user" });
    expect(existsSync(join(tempRoot, ".dragnet", "log-verbosity.json"))).toBe(false);
  });

  it("round-trips save then read", async () => {
    await saveLogVerbosity({ level: "debug" });
    expect(readLogVerbosity()).toEqual({ level: "debug" });
    const raw = JSON.parse(
      readFileSync(join(tempRoot, ".dragnet", "log-verbosity.json"), "utf8"),
    );
    expect(raw.level).toBe("debug");
  });

  it("clearLogVerbosityCache forces a fresh disk read", async () => {
    await saveLogVerbosity({ level: "warn" });
    writeFileSync(
      join(tempRoot, ".dragnet", "log-verbosity.json"),
      JSON.stringify({ level: "error" }, null, 2),
    );
    expect(readLogVerbosity().level).toBe("warn");
    clearLogVerbosityCache();
    expect(readLogVerbosity().level).toBe("error");
  });

  it("falls back to defaults on corrupt JSON", () => {
    mkdirSync(join(tempRoot, ".dragnet"), { recursive: true });
    writeFileSync(join(tempRoot, ".dragnet", "log-verbosity.json"), "{not json");
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(readLogVerbosity()).toEqual({ level: "user" });
    } finally {
      console.warn = warn;
    }
  });

  it("falls back to default when level field is invalid", () => {
    mkdirSync(join(tempRoot, ".dragnet"), { recursive: true });
    writeFileSync(
      join(tempRoot, ".dragnet", "log-verbosity.json"),
      JSON.stringify({ level: "trace" }),
    );
    expect(readLogVerbosity()).toEqual({ level: "user" });
  });
});

describe("server log helper respects verbosity", () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "dragnet-log-helper-"));
    process.chdir(tempRoot);
    clearLogVerbosityCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    clearLogVerbosityCache();
  });

  it("suppresses debug at User and emits at Debug", async () => {
    const { dragnetLog } = await import("../src/lib/logVerbosity");
    dragnetLog.debug("[scan] getRealPrs: repoId=x mode=remote-volume");
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();

    await saveLogVerbosity({ level: "debug" });
    dragnetLog.debug("[scan] getRealPrs: repoId=x mode=remote-volume");
    expect(console.debug).toHaveBeenCalled();
  });

  it("always emits error at User", async () => {
    const { dragnetLog } = await import("../src/lib/logVerbosity");
    dragnetLog.error("boom");
    expect(console.error).toHaveBeenCalled();
  });
});
