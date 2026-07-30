import { describe, it, expect } from "vitest";
import {
  skippedFinding,
  shouldRunHostTier1,
  DEFAULT_TEST_COMMAND,
  DEFAULT_INSTALL_COMMAND,
} from "@/src/services/deterministicChecks/helpers";

describe("skippedFinding", () => {
  it("returns a DeterministicFinding with severity info and category Skipped", () => {
    const result = skippedFinding("eslint", "node_modules/ missing");
    expect(result.severity).toBe("info");
    expect(result.category).toBe("Skipped");
    expect(result.filename).toBe("<tooling>");
    expect(result.line).toBeNull();
    expect(result.source).toBe("eslint");
    expect(result.explanation).toBe("[eslint] node_modules/ missing");
  });

  it("prepends source tag to message", () => {
    const result = skippedFinding("tsc", "timeout after 60s");
    expect(result.explanation).toBe("[tsc] timeout after 60s");
  });

  it("works with 'runner' source", () => {
    const result = skippedFinding("runner", "podman unavailable");
    expect(result.source).toBe("runner");
    expect(result.explanation).toBe("[runner] podman unavailable");
  });
});

describe("shouldRunHostTier1", () => {
  it("runs for local path-only checkout", () => {
    expect(shouldRunHostTier1({ path: "/home/dev/repo", cloneUrl: null, localPath: null })).toBe(true);
  });

  it("skips when path is missing", () => {
    expect(shouldRunHostTier1({ path: null, cloneUrl: null })).toBe(false);
    expect(shouldRunHostTier1(null)).toBe(false);
  });

  it("skips remote/volume-backed when cloneUrl is set even if path exists", () => {
    expect(
      shouldRunHostTier1({
        path: "/empty/host/mirror",
        cloneUrl: "https://github.com/acme/app.git",
        localPath: null,
      }),
    ).toBe(false);
  });

  it("skips volume container mode (localPath=/workspace)", () => {
    expect(
      shouldRunHostTier1({
        path: "/workspace",
        cloneUrl: null,
        localPath: "/workspace",
      }),
    ).toBe(false);
  });
});

describe("default quality-gate commands", () => {
  it("defaults test command to typecheck + lint (not e2e)", () => {
    expect(DEFAULT_TEST_COMMAND).toBe("npm run typecheck && npm run lint");
    expect(DEFAULT_TEST_COMMAND).not.toMatch(/\bnpm test\b/);
    expect(DEFAULT_INSTALL_COMMAND).toBe("npm install");
  });
});
