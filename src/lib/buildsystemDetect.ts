import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export type BuildSystem =
  | "node"
  | "rust"
  | "python"
  | "go"
  | "ruby"
  | "php"
  | "unknown";

export interface DetectedBuildSystem {
  buildSystem: BuildSystem;
  image: string;
  warn: string | null;
}

export const NODE_IMAGE = "node:20-alpine";
export const RUST_IMAGE = "rust:latest";
export const PYTHON_IMAGE = "python:3.12-slim";
export const GO_IMAGE = "golang:1.22-alpine";
export const RUBY_IMAGE = "ruby:3.3-alpine";
export const PHP_IMAGE = "composer:latest";
export const FALLBACK_IMAGE = NODE_IMAGE;

const BUILD_SYSTEM_DETECTORS: Array<{
  files: string[];
  buildSystem: BuildSystem;
  image: string;
}> = [
  {
    files: ["Cargo.toml"],
    buildSystem: "rust",
    image: RUST_IMAGE,
  },
  {
    files: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
    buildSystem: "python",
    image: PYTHON_IMAGE,
  },
  {
    files: ["go.mod"],
    buildSystem: "go",
    image: GO_IMAGE,
  },
  {
    files: ["Gemfile"],
    buildSystem: "ruby",
    image: RUBY_IMAGE,
  },
  {
    files: ["composer.json"],
    buildSystem: "php",
    image: PHP_IMAGE,
  },
  {
    files: ["package.json"],
    buildSystem: "node",
    image: NODE_IMAGE,
  },
];

export async function detectBuildSystem(
  rootDir: string,
): Promise<DetectedBuildSystem> {
  for (const detector of BUILD_SYSTEM_DETECTORS) {
    for (const file of detector.files) {
      if (existsSync(join(rootDir, file))) {
        if (detector.buildSystem === "rust" || detector.buildSystem === "python") {
          return {
            buildSystem: detector.buildSystem,
            image: detector.image,
            warn: `Detected ${detector.buildSystem} project (${file}), but container runner v1 only ships the Node.js image. Tier 2 checks will be skipped for this language.`,
          };
        }
        return {
          buildSystem: detector.buildSystem,
          image: detector.image,
          warn: null,
        };
      }
    }
  }

  return {
    buildSystem: "unknown",
    image: FALLBACK_IMAGE,
    warn: "No recognized build config found — falling back to node:20-alpine. Consider adding a package.json, Cargo.toml, pyproject.toml, go.mod, Gemfile, or composer.json.",
  };
}
