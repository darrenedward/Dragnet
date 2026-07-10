import { describe, it, expect } from "vitest";
import {
  isConfigFile,
  isGeneratedFile,
  isTrivialFile,
  classifyDiff,
} from "../src/lib/diffClassifier";

describe("isConfigFile", () => {
  it("recognizes tsconfig.json", () => {
    expect(isConfigFile("tsconfig.json")).toBe(true);
  });

  it("recognizes nested .gitignore", () => {
    expect(isConfigFile("some/path/.gitignore")).toBe(true);
  });

  it("recognizes vite.config.ts", () => {
    expect(isConfigFile("vite.config.ts")).toBe(true);
  });

  it("recognizes Dockerfile", () => {
    expect(isConfigFile("Dockerfile")).toBe(true);
  });

  it("rejects source files", () => {
    expect(isConfigFile("src/index.ts")).toBe(false);
  });
});

describe("isGeneratedFile", () => {
  it("recognizes package-lock.json", () => {
    expect(isGeneratedFile("package-lock.json")).toBe(true);
  });

  it("recognizes Cargo.lock", () => {
    expect(isGeneratedFile("Cargo.lock")).toBe(true);
  });

  it("recognizes files in dist/", () => {
    expect(isGeneratedFile("dist/bundle.js")).toBe(true);
  });

  it("recognizes go.sum", () => {
    expect(isGeneratedFile("go.sum")).toBe(true);
  });

  it("rejects hand-written go files", () => {
    expect(isGeneratedFile("main.go")).toBe(false);
  });
});

describe("isTrivialFile", () => {
  it("returns true for README.md", () => {
    expect(isTrivialFile("README.md")).toBe(true);
  });

  it("returns true for LICENSE", () => {
    expect(isTrivialFile("LICENSE")).toBe(true);
  });

  it("returns true for generated lockfile", () => {
    expect(isTrivialFile("yarn.lock")).toBe(true);
  });

  it("returns true for config file", () => {
    expect(isTrivialFile(".editorconfig")).toBe(true);
  });

  it("returns false for source code", () => {
    expect(isTrivialFile("src/app/page.tsx")).toBe(false);
  });

  it("returns false for test files", () => {
    expect(isTrivialFile("src/__tests__/foo.test.ts")).toBe(false);
  });
});

describe("classifyDiff", () => {
  it("marks a diff as trivial when all files are config/docs/generated", () => {
    const result = classifyDiff([
      { filename: "README.md" },
      { filename: "LICENSE" },
      { filename: "package-lock.json" },
      { filename: ".gitignore" },
    ]);
    expect(result.isTrivial).toBe(true);
    expect(result.codeFiles).toBe(0);
    expect(result.trivialFiles).toBe(4);
    expect(result.totalFiles).toBe(4);
  });

  it("marks a diff as non-trivial when any source file is changed", () => {
    const result = classifyDiff([
      { filename: "README.md" },
      { filename: "src/index.ts" },
    ]);
    expect(result.isTrivial).toBe(false);
    expect(result.codeFiles).toBe(1);
    expect(result.trivialFiles).toBe(1);
    expect(result.totalFiles).toBe(2);
  });

  it("marks a diff as non-trivial when all files are source", () => {
    const result = classifyDiff([
      { filename: "src/app.ts" },
      { filename: "src/lib/util.ts" },
    ]);
    expect(result.isTrivial).toBe(false);
    expect(result.codeFiles).toBe(2);
    expect(result.trivialFiles).toBe(0);
    expect(result.totalFiles).toBe(2);
  });

  it("handles empty file list", () => {
    const result = classifyDiff([]);
    expect(result.isTrivial).toBe(true);
    expect(result.codeFiles).toBe(0);
    expect(result.trivialFiles).toBe(0);
    expect(result.totalFiles).toBe(0);
  });
});
