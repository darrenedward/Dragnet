import { describe, it, expect } from "vitest";
import { detectBuildSystem, NODE_IMAGE, RUST_IMAGE, PYTHON_IMAGE, GO_IMAGE, RUBY_IMAGE, PHP_IMAGE, FALLBACK_IMAGE } from "../src/lib/buildsystemDetect";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dragnet-bs-test-"));
  return dir;
}

function removeTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("detectBuildSystem", () => {
  it("detects node from package.json", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("node");
      expect(result.image).toBe(NODE_IMAGE);
      expect(result.warn).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects rust from Cargo.toml", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "test"\n');
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("rust");
      expect(result.image).toBe(RUST_IMAGE);
      expect(result.warn).toContain("rust");
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects python from pyproject.toml", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "pyproject.toml"), '[build-system]\n');
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("python");
      expect(result.image).toBe(PYTHON_IMAGE);
      expect(result.warn).toContain("python");
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects python from requirements.txt", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "requirements.txt"), "requests\n");
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("python");
      expect(result.image).toBe(PYTHON_IMAGE);
      expect(result.warn).toContain("python");
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects go from go.mod", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "go.mod"), "module test\n");
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("go");
      expect(result.image).toBe(GO_IMAGE);
      expect(result.warn).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects ruby from Gemfile", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "Gemfile"), 'source "https://rubygems.org"\n');
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("ruby");
      expect(result.image).toBe(RUBY_IMAGE);
      expect(result.warn).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it("detects php from composer.json", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "composer.json"), JSON.stringify({ name: "test/pkg" }));
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("php");
      expect(result.image).toBe(PHP_IMAGE);
      expect(result.warn).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it("falls back to node:20-alpine for unrecognized directories", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "some_random_file.txt"), "hello");
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("unknown");
      expect(result.image).toBe(FALLBACK_IMAGE);
      expect(result.warn).toContain("falling back");
    } finally {
      removeTempDir(dir);
    }
  });

  it("falls back for empty directory", async () => {
    const dir = createTempDir();
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("unknown");
      expect(result.warn).toContain("falling back");
    } finally {
      removeTempDir(dir);
    }
  });

  it("prioritizes rust over node when both configs exist", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "Cargo.toml"), '[package]\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("rust");
      expect(result.image).toBe(RUST_IMAGE);
    } finally {
      removeTempDir(dir);
    }
  });

  it("prioritizes node when package.json alone exists", async () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    try {
      const result = await detectBuildSystem(dir);
      expect(result.buildSystem).toBe("node");
      expect(result.image).toBe(NODE_IMAGE);
    } finally {
      removeTempDir(dir);
    }
  });
});
