import path from "node:path";
import { computePrSizeProfile, isProfiledCodeFile } from "@/src/lib/prSizeProfile";
import type {
  DiffManifest,
  FileClass,
  FileClassification,
  LargePrTier,
  ReviewFileInput,
  TierResult,
} from "./types";

export const NORMAL_MAX_LINES = 800;
export const NORMAL_MAX_CODE_FILES = 40;
export const OVERSIZED_LINES = 3000;
export const OVERSIZED_CODE_FILES = 100;

/**
 * Runtime overrides for tier thresholds. Callers pass these when they
 * want values from `.dragnet/review-limits.json` instead of the
 * constants. Omitted fields fall back to the constants.
 */
export interface TierThresholds {
  normalMaxLines?: number;
  normalMaxCodeFiles?: number;
  oversizedLines?: number;
  oversizedCodeFiles?: number;
}

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

const DOC_EXTENSIONS = new Set([".adoc", ".markdown", ".md", ".mdx", ".rst", ".txt"]);
const CODE_WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"]);

export function buildDiffManifest(
  files: ReviewFileInput[],
  commitCount?: number | null,
  thresholds?: TierThresholds,
): DiffManifest {
  try {
    const classifications = files
      .map(classifyFile)
      .sort((a, b) => a.filename.localeCompare(b.filename));
    const totalLines = classifications.reduce((sum, f) => sum + f.lineCount, 0);
    const codeFiles = classifications.filter((f) => f.fileClass === "code");
    const codeLines = codeFiles.reduce((sum, f) => sum + f.lineCount, 0);
    const tierResult = assertTierValues(codeLines, codeFiles.length, thresholds);
    return {
      files: classifications,
      totalLines,
      codeLines,
      codeFileCount: codeFiles.length,
      docsFileCount: classifications.filter((f) => f.fileClass === "docs").length,
      generatedFileCount: classifications.filter((f) => f.fileClass === "generated").length,
      lockFileCount: classifications.filter((f) => f.fileClass === "lock").length,
      vendorFileCount: classifications.filter((f) => f.fileClass === "vendor").length,
      sizeProfile: computePrSizeProfile(classifications, commitCount),
      tier: tierResult.tier,
      message: "message" in tierResult ? tierResult.message : undefined,
    };
  } catch (err) {
    console.warn("[largePrMode] manifest build failed; falling back to normal tier:", err);
    return {
      files: [],
      totalLines: 0,
      codeLines: 0,
      codeFileCount: 0,
      docsFileCount: 0,
      generatedFileCount: 0,
      lockFileCount: 0,
      vendorFileCount: 0,
      sizeProfile: computePrSizeProfile([], commitCount),
      tier: "normal",
    };
  }
}

export function assertTier(manifest: DiffManifest, thresholds?: TierThresholds): TierResult {
  return assertTierValues(manifest.codeLines, manifest.codeFileCount, thresholds);
}

export function classifyFile(file: ReviewFileInput): FileClassification {
  const filename = normalizePath(file.filename);
  const additions = Math.max(0, Number(file.additions ?? 0));
  const deletions = Math.max(0, Number(file.deletions ?? 0));
  const fileClass = classifyPath(filename, file);
  return {
    ...file,
    filename,
    additions,
    deletions,
    lineCount: additions + deletions,
    fileClass,
    packageKey: packageKey(filename),
    typeBucket: typeBucket(filename),
  };
}

export function classifyPath(filename: string, file?: ReviewFileInput): FileClass {
  const normalized = normalizePath(filename).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] || normalized;
  const ext = path.extname(basename);

  if (LOCKFILE_NAMES.has(basename) || basename.endsWith(".lock")) return "lock";
  if (
    parts.includes("node_modules") ||
    parts.includes("vendor") ||
    parts.includes("third_party") ||
    parts.includes(".vendored")
  ) return "vendor";
  if (
    parts.some((part) => [".next", "build", "coverage", "dist", "generated", "__generated__"].includes(part)) ||
    basename.includes(".generated.") ||
    basename.includes(".min.") ||
    basename.endsWith(".map") ||
    hasGeneratedHeader(file?.modifiedContent)
  ) return "generated";
  if (
    DOC_EXTENSIONS.has(ext) ||
    basename === "license" ||
    basename.startsWith("changelog") ||
    parts.includes("docs") ||
    parts.includes("doc") ||
    parts[0] === ".agent-os" ||
    (parts[0] === ".github" && !(parts[1] === "workflows" && CODE_WORKFLOW_EXTENSIONS.has(ext)))
  ) return "docs";
  return isProfiledCodeFile(filename) ? "code" : "docs";
}

export function packageKey(filename: string): string {
  const parts = normalizePath(filename).split("/").filter(Boolean);
  if (parts.length === 0) return ".";
  if (["apps", "packages", "services", "libs"].includes(parts[0]) && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

export function typeBucket(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts-js";
  if ([".css", ".scss", ".sass", ".less"].includes(ext)) return "styles";
  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) return "config";
  if ([".prisma", ".sql"].includes(ext)) return "schema";
  if ([".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"].some((suffix) => filename.endsWith(suffix))) return "tests";
  return ext ? ext.slice(1) : "other";
}

function assertTierValues(
  codeLines: number,
  codeFileCount: number,
  thresholds?: TierThresholds,
): TierResult {
  const oversizedLines = thresholds?.oversizedLines ?? OVERSIZED_LINES;
  const oversizedCodeFiles = thresholds?.oversizedCodeFiles ?? OVERSIZED_CODE_FILES;
  const normalMaxLines = thresholds?.normalMaxLines ?? NORMAL_MAX_LINES;
  const normalMaxCodeFiles = thresholds?.normalMaxCodeFiles ?? NORMAL_MAX_CODE_FILES;
  if (codeLines > oversizedLines || codeFileCount > oversizedCodeFiles) {
    return {
      ok: true,
      tier: "oversized",
      message: `Oversized PR (${codeLines.toLocaleString()} code lines, ${codeFileCount.toLocaleString()} code files). Split recommended; review will run best-effort in chunks.`,
    };
  }
  if (codeLines > normalMaxLines || codeFileCount > normalMaxCodeFiles) {
    return { ok: true, tier: "grouped" };
  }
  return { ok: true, tier: "normal" };
}

function hasGeneratedHeader(content?: string | null): boolean {
  if (!content) return false;
  return content.split("\n").slice(0, 5).some((line) => /auto-generated|generated file/i.test(line));
}

function normalizePath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\/+/, "");
}
