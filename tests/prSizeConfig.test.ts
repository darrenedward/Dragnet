import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LIMITS,
  clearLimitsCache,
  readLimits,
  saveLimits,
} from "../src/lib/prSizeConfig";

/**
 * prSizeConfig uses `process.cwd()/.dragnet/review-limits.json` and a
 * globalThis cache. Tests swap `cwd` to a temp dir and reset the cache
 * between cases so each one starts from a clean slate.
 */
describe("prSizeConfig", () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "dragnet-limits-"));
    process.chdir(tempRoot);
    clearLimitsCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    clearLimitsCache();
  });

  it("returns DEFAULT_LIMITS when no file exists", () => {
    expect(readLimits()).toEqual(DEFAULT_LIMITS);
  });

  it("does NOT write a file on first read (matches llmPresets pattern)", () => {
    readLimits();
    const path = join(tempRoot, ".dragnet", "review-limits.json");
    // File appears only when the user explicitly saves via the UI.
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips saveLimits then readLimits", async () => {
    const next = {
      ...DEFAULT_LIMITS,
      chunkLineCap: 1500,
      normalMaxLines: 2000,
      maxFilesPerReview: 75,
    };
    await saveLimits(next);
    // Cache should reflect the new values without another disk read.
    expect(readLimits()).toEqual(next);
    // Disk should also reflect them.
    const raw = JSON.parse(
      readFileSync(join(tempRoot, ".dragnet", "review-limits.json"), "utf8"),
    );
    expect(raw.chunkLineCap).toBe(1500);
    expect(raw.maxFilesPerReview).toBe(75);
  });

  it("clearLimitsCache forces a fresh disk read", async () => {
    await saveLimits({ ...DEFAULT_LIMITS, chunkLineCap: 999 });
    // Mutate the file behind the cache.
    writeFileSync(
      join(tempRoot, ".dragnet", "review-limits.json"),
      JSON.stringify({ ...DEFAULT_LIMITS, chunkLineCap: 4242 }, null, 2),
    );
    // Without clearing: still 999.
    expect(readLimits().chunkLineCap).toBe(999);
    // After clearing: picks up 4242 from disk.
    clearLimitsCache();
    expect(readLimits().chunkLineCap).toBe(4242);
  });

  it("falls back to defaults when the file is corrupt JSON", () => {
    const dir = join(tempRoot, ".dragnet");
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-limits.json"), "{not json");
    // Silence the expected warn.
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(readLimits()).toEqual(DEFAULT_LIMITS);
    } finally {
      console.warn = warn;
    }
  });

  it("fills missing fields from defaults rather than rejecting the file", () => {
    const dir = join(tempRoot, ".dragnet");
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "review-limits.json"),
      JSON.stringify({ chunkLineCap: 1234 }),
    );
    const got = readLimits();
    expect(got.chunkLineCap).toBe(1234);
    expect(got.minUsefulChunkLines).toBe(DEFAULT_LIMITS.minUsefulChunkLines);
    expect(got.oversizedLines).toBe(DEFAULT_LIMITS.oversizedLines);
    expect(got.maxFilesPerReview).toBe(0);
  });

  it("treats non-numeric fields as missing", () => {
    const dir = join(tempRoot, ".dragnet");
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "review-limits.json"),
      JSON.stringify({ chunkLineCap: "big", normalMaxLines: null }),
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      const got = readLimits();
      expect(got.chunkLineCap).toBe(DEFAULT_LIMITS.chunkLineCap);
      expect(got.normalMaxLines).toBe(DEFAULT_LIMITS.normalMaxLines);
    } finally {
      console.warn = warn;
    }
  });

  it("written file is mode 0600 (chmod enforced)", async () => {
    await saveLimits(DEFAULT_LIMITS);
    const stat = require("node:fs").statSync(
      join(tempRoot, ".dragnet", "review-limits.json"),
    );
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
