import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * skepticConfig tests — atomic write, cache, defensive coercion.
 * Mirrors the pattern of the prSizeConfig tests.
 */

let tmpDir: string;
const originalCwd = process.cwd();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skeptic-config-"));
  process.chdir(tmpDir);
  // Clear the global cache between tests.
  const g = globalThis as unknown as {
    __skepticSettingsCache?: unknown;
    __skepticSettingsInitialized?: boolean;
  };
  g.__skepticSettingsCache = null;
  g.__skepticSettingsInitialized = false;
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("skepticConfig — readSkeptic", () => {
  it("returns DEFAULT_SKEPTIC when no file exists", async () => {
    const { readSkeptic, DEFAULT_SKEPTIC } = await import("../src/lib/skepticConfig");
    expect(readSkeptic()).toEqual(DEFAULT_SKEPTIC);
    expect(readSkeptic().enabled).toBe(false);
  });

  it("returns file contents when file exists", async () => {
    fs.mkdirSync(path.join(tmpDir, ".dragnet"));
    fs.writeFileSync(
      path.join(tmpDir, ".dragnet", "skeptic-settings.json"),
      JSON.stringify({ enabled: true }),
      { mode: 0o600 },
    );
    const { readSkeptic } = await import("../src/lib/skepticConfig");
    expect(readSkeptic().enabled).toBe(true);
  });

  it("falls back to defaults on malformed JSON (warns, never throws)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".dragnet"));
    fs.writeFileSync(
      path.join(tmpDir, ".dragnet", "skeptic-settings.json"),
      "this is not json",
      { mode: 0o600 },
    );
    const warnSpy = viSpyWarn();
    const { readSkeptic, DEFAULT_SKEPTIC } = await import("../src/lib/skepticConfig");
    expect(readSkeptic()).toEqual(DEFAULT_SKEPTIC);
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0] ?? "").includes("skeptic-settings.json unreadable"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("falls back to defaults when enabled field is missing", async () => {
    fs.mkdirSync(path.join(tmpDir, ".dragnet"));
    fs.writeFileSync(
      path.join(tmpDir, ".dragnet", "skeptic-settings.json"),
      JSON.stringify({ otherField: "yes" }),
      { mode: 0o600 },
    );
    const { readSkeptic, DEFAULT_SKEPTIC } = await import("../src/lib/skepticConfig");
    expect(readSkeptic()).toEqual(DEFAULT_SKEPTIC);
  });
});

describe("skepticConfig — saveSkeptic", () => {
  it("writes file with mode 0600 atomically", async () => {
    const { saveSkeptic, readSkeptic } = await import("../src/lib/skepticConfig");
    await saveSkeptic({ enabled: true });
    const filePath = path.join(tmpDir, ".dragnet", "skeptic-settings.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readSkeptic().enabled).toBe(true);
  });

  it("round-trips through cache (no second disk read)", async () => {
    const { saveSkeptic, readSkeptic } = await import("../src/lib/skepticConfig");
    await saveSkeptic({ enabled: true });
    // Delete the file — cached value should still be returned.
    fs.unlinkSync(path.join(tmpDir, ".dragnet", "skeptic-settings.json"));
    expect(readSkeptic().enabled).toBe(true);
  });
});

describe("skepticConfig — clearSkepticCache", () => {
  it("forces next read to hit disk", async () => {
    const { saveSkeptic, readSkeptic, clearSkepticCache } = await import(
      "../src/lib/skepticConfig"
    );
    await saveSkeptic({ enabled: true });
    expect(readSkeptic().enabled).toBe(true);
    // Mutate file under the cache.
    fs.writeFileSync(
      path.join(tmpDir, ".dragnet", "skeptic-settings.json"),
      JSON.stringify({ enabled: false }),
      { mode: 0o600 },
    );
    expect(readSkeptic().enabled).toBe(true); // still cached
    clearSkepticCache();
    expect(readSkeptic().enabled).toBe(false); // now from disk
  });
});

// Helper to keep the spy setup uniform across tests.
function viSpyWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}
