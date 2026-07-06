import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { javascriptDetector } from "@/src/services/deterministicChecks/javascriptDetector";
import { typescriptDetector } from "@/src/services/deterministicChecks/typescriptDetector";

let tempDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "detector-test-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

describe("javascriptDetector.detect", () => {
  it("returns detection result when package.json exists", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    const result = await javascriptDetector.detect(dir);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("javascript");
    expect(result!.rootDir).toBe(dir);
    expect(result!.hasNodeModules).toBe(false);
  });

  it("returns null when package.json is missing", async () => {
    const dir = tmpDir();
    const result = await javascriptDetector.detect(dir);
    expect(result).toBeNull();
  });

  it("reads scripts from package.json", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
    const result = await javascriptDetector.detect(dir);
    expect(result!.scripts).toEqual({ lint: "eslint ." });
  });

  it("handles malformed package.json gracefully", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), "not valid json");
    const result = await javascriptDetector.detect(dir);
    expect(result).not.toBeNull();
    expect(result!.scripts).toEqual({});
  });

  it("detects node_modules presence", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({}));
    mkdirSync(join(dir, "node_modules"));
    const result = await javascriptDetector.detect(dir);
    expect(result!.hasNodeModules).toBe(true);
  });
});

describe("typescriptDetector.detect", () => {
  it("returns detection result when both package.json and tsconfig.json exist", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({}));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    const result = await typescriptDetector.detect(dir);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("typescript");
    expect(result!.tsconfigPath).toBe(join(dir, "tsconfig.json"));
  });

  it("returns null when only package.json exists", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({}));
    const result = await typescriptDetector.detect(dir);
    expect(result).toBeNull();
  });

  it("returns null when only tsconfig.json exists", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({}));
    const result = await typescriptDetector.detect(dir);
    expect(result).toBeNull();
  });

  it("returns null when neither file exists", async () => {
    const dir = tmpDir();
    const result = await typescriptDetector.detect(dir);
    expect(result).toBeNull();
  });

  it("reads scripts from package.json", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({}));
    const result = await typescriptDetector.detect(dir);
    expect(result!.scripts).toEqual({ typecheck: "tsc --noEmit" });
  });

  it("handles malformed package.json gracefully", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "package.json"), "broken");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({}));
    const result = await typescriptDetector.detect(dir);
    expect(result).not.toBeNull();
    expect(result!.scripts).toEqual({});
  });
});
