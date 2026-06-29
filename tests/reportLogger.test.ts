import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReport,
  formatReportLine,
  REPORTS_DIR_NAME,
} from "../src/services/largePrReview/reportLogger";

const FIXTURE_TS = new Date("2026-06-29T17:14:23.456Z");

function fixtureNow() {
  return FIXTURE_TS;
}

describe("formatReportLine", () => {
  it("formats a basic info line with ISO timestamp", () => {
    const line = formatReportLine({
      message: "Large PR Mode activated: 3 chunks",
      now: fixtureNow,
    });
    expect(line).toBe(
      "2026-06-29T17:14:23.456Z [info] Large PR Mode activated: 3 chunks",
    );
  });

  it("honors the level parameter", () => {
    const line = formatReportLine({
      message: "Chunk failed",
      level: "error",
      now: fixtureNow,
    });
    expect(line).toBe("2026-06-29T17:14:23.456Z [error] Chunk failed");
  });

  it("includes the chunkId segment when provided", () => {
    const line = formatReportLine({
      message: "scanning",
      level: "info",
      chunkId: "chunk-2",
      now: fixtureNow,
    });
    expect(line).toBe("2026-06-29T17:14:23.456Z [info] [chunk-2] scanning");
  });

  it("omits the chunkId segment when null", () => {
    const line = formatReportLine({
      message: "no chunk",
      chunkId: null,
      now: fixtureNow,
    });
    expect(line).toBe("2026-06-29T17:14:23.456Z [info] no chunk");
  });

  it("omits the chunkId segment when undefined", () => {
    const line = formatReportLine({
      message: "no chunk",
      now: fixtureNow,
    });
    expect(line).toBe("2026-06-29T17:14:23.456Z [info] no chunk");
  });

  it("defaults level to info when not specified", () => {
    const line = formatReportLine({ message: "x", now: fixtureNow });
    expect(line).toContain("[info]");
  });
});

describe("appendReport", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp();
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("creates the .dragnet/reports/ directory and writes the line", async () => {
    await appendReport(sandbox, "run-1", "first line");

    const target = join(sandbox, REPORTS_DIR_NAME, "run-1.log");
    const contents = await readFile(target, "utf8");
    expect(contents).toBe("first line\n");
  });

  it("appends multiple lines preserving order", async () => {
    await appendReport(sandbox, "run-2", "line-a");
    await appendReport(sandbox, "run-2", "line-b");
    await appendReport(sandbox, "run-2", "line-c");

    const contents = await readFile(
      join(sandbox, REPORTS_DIR_NAME, "run-2.log"),
      "utf8",
    );
    expect(contents).toBe("line-a\nline-b\nline-c\n");
  });

  it("isolates runs into separate files", async () => {
    await appendReport(sandbox, "run-a", "alpha");
    await appendReport(sandbox, "run-b", "beta");

    const a = await readFile(join(sandbox, REPORTS_DIR_NAME, "run-a.log"), "utf8");
    const b = await readFile(join(sandbox, REPORTS_DIR_NAME, "run-b.log"), "utf8");
    expect(a).toBe("alpha\n");
    expect(b).toBe("beta\n");
  });

  it("writes into the given repoPath, not process.cwd()", async () => {
    // Critical invariant: artifact must land in the SCANNED repo, not the
    // Dragnet install dir. See project_per_scan_artifacts_use_repo_path memory.
    await appendReport(sandbox, "run-x", "payload");

    const inSandbox = await stat(join(sandbox, REPORTS_DIR_NAME, "run-x.log"));
    expect(inSandbox.isFile()).toBe(true);

    // And NOT under process.cwd() (the Dragnet install's .dragnet/reports/).
    const wrongPath = join(process.cwd(), REPORTS_DIR_NAME, "run-x.log");
    await expect(stat(wrongPath)).rejects.toThrow();
  });

  it("is a no-op when repoPath is empty (legacy callers / tests)", async () => {
    await appendReport("", "run-1", "nope");
    // Nothing to assert beyond no throw and no file written — empty repoPath
    // returns early. Verify by checking that no file was created in process.cwd().
    const wrongPath = join(process.cwd(), REPORTS_DIR_NAME, "run-1.log");
    await expect(stat(wrongPath)).rejects.toThrow();
  });

  it("is a no-op when runId is empty", async () => {
    await appendReport(sandbox, "", "nope");
    // No file should exist in the sandbox's reports dir at all.
    const dir = join(sandbox, REPORTS_DIR_NAME);
    await expect(stat(join(dir, ".log"))).rejects.toThrow();
  });

  it("swallows fs errors silently (best-effort contract)", async () => {
    // Pointing at a path that can't be created — appendReport must not throw.
    // /dev/null is a char device, so mkdir under it fails immediately with ENOTDIR.
    await expect(
      appendReport("/dev/null", "run-1", "line"),
    ).resolves.toBeUndefined();
  });
});

async function mkdtemp(): Promise<string> {
  const dir = join(tmpdir(), `reportLogger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
