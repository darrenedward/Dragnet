import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  DEFAULT_SCAN_STATE_ROOT,
  getScanStateRoot,
  getScanStatePath,
  getScanStateSubdir,
  getLegacyScanStatePath,
} from "../src/lib/scanStatePath";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  if ("DRAGNET_SCAN_STATE_ROOT" in ORIGINAL_ENV) {
    process.env.DRAGNET_SCAN_STATE_ROOT = ORIGINAL_ENV.DRAGNET_SCAN_STATE_ROOT;
  } else {
    delete process.env.DRAGNET_SCAN_STATE_ROOT;
  }
});

describe("getScanStateRoot", () => {
  it("returns default when env unset", () => {
    delete process.env.DRAGNET_SCAN_STATE_ROOT;
    expect(getScanStateRoot()).toBe(DEFAULT_SCAN_STATE_ROOT);
    expect(DEFAULT_SCAN_STATE_ROOT).toBe("/var/lib/dragnet/scans");
  });

  it("returns env override when set", () => {
    process.env.DRAGNET_SCAN_STATE_ROOT = "/custom/path";
    expect(getScanStateRoot()).toBe("/custom/path");
  });

  it("trailing slash not added by default", () => {
    expect(DEFAULT_SCAN_STATE_ROOT).not.toMatch(/\/$/);
  });
});

describe("getScanStatePath", () => {
  it("returns <root>/<repoId>", () => {
    delete process.env.DRAGNET_SCAN_STATE_ROOT;
    expect(getScanStatePath("repo-123")).toBe("/var/lib/dragnet/scans/repo-123");
  });

  it("works with env override", () => {
    process.env.DRAGNET_SCAN_STATE_ROOT = "/mnt/scan-state";
    expect(getScanStatePath("abc")).toBe("/mnt/scan-state/abc");
  });

  it("handles repoIds with special characters", () => {
    expect(getScanStatePath("dragnet-repo-uuid-v4")).toContain("dragnet-repo-uuid-v4");
  });
});

describe("getScanStateSubdir", () => {
  it("returns <root>/<repoId>/<subdir>", () => {
    expect(getScanStateSubdir("r1", "checkpoints")).toBe(
      "/var/lib/dragnet/scans/r1/checkpoints",
    );
  });
});

describe("getLegacyScanStatePath", () => {
  it("returns <repoPath>/.dragnet", () => {
    expect(getLegacyScanStatePath("/home/user/my-repo")).toBe(
      "/home/user/my-repo/.dragnet",
    );
  });
});
