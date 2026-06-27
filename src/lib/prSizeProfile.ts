export type PrSizeTier = "small" | "medium" | "large" | "oversized";

export interface PrSizeProfileInputFile {
  filename: string;
  additions?: number | null;
  deletions?: number | null;
}

export interface PrSizeProfile {
  tier: PrSizeTier;
  codeLines: number;
  codeFiles: number;
  totalFiles: number;
  additions: number;
  deletions: number;
  commitCount: number | null;
  label: string;
  message: string | null;
}

export const PR_SIZE_THRESHOLDS = {
  mediumCodeLines: 500,
  largeCodeLines: 1500,
  oversizedCodeLines: 3000,
  mediumCommits: 15,
  largeCommits: 40,
  oversizedCommits: 100,
} as const;

const DOC_EXTENSIONS = new Set([
  ".adoc",
  ".markdown",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
]);

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

const GENERATED_SEGMENTS = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "generated",
  "__generated__",
]);

export function isProfiledCodeFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const basename = parts[parts.length - 1] || normalized;

  if (!basename) return false;
  if (LOCKFILE_NAMES.has(basename)) return false;
  if (basename.endsWith(".lock")) return false;
  if (basename.endsWith(".map")) return false;
  if (basename.includes(".generated.")) return false;
  if (basename.includes(".min.")) return false;

  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) return false;
  if (parts.includes("docs") || parts.includes("doc")) return false;

  const dot = basename.lastIndexOf(".");
  const ext = dot >= 0 ? basename.slice(dot) : "";
  if (DOC_EXTENSIONS.has(ext)) return false;

  return true;
}

export function computePrSizeProfile(
  files: PrSizeProfileInputFile[],
  commitCount?: number | null,
): PrSizeProfile {
  const safeCommitCount = Number.isFinite(commitCount) ? Number(commitCount) : null;
  let additions = 0;
  let deletions = 0;
  let codeLines = 0;
  let codeFiles = 0;

  for (const file of files) {
    const fileAdditions = Math.max(0, Number(file.additions ?? 0));
    const fileDeletions = Math.max(0, Number(file.deletions ?? 0));
    additions += fileAdditions;
    deletions += fileDeletions;

    if (isProfiledCodeFile(file.filename)) {
      codeFiles += 1;
      codeLines += fileAdditions + fileDeletions;
    }
  }

  const tier = pickSizeTier(codeLines, safeCommitCount);
  const label = formatPrSizeProfileLabel(codeLines, safeCommitCount);

  return {
    tier,
    codeLines,
    codeFiles,
    totalFiles: files.length,
    additions,
    deletions,
    commitCount: safeCommitCount,
    label,
    message: messageForTier(tier),
  };
}

export function formatPrSizeProfileLabel(
  codeLines: number,
  commitCount?: number | null,
): string {
  const lineLabel = `${codeLines.toLocaleString()} code line${codeLines === 1 ? "" : "s"}`;
  if (commitCount === null || commitCount === undefined) return lineLabel;
  return `${lineLabel} · ${commitCount.toLocaleString()} commit${commitCount === 1 ? "" : "s"}`;
}

function pickSizeTier(codeLines: number, commitCount: number | null): PrSizeTier {
  if (
    codeLines > PR_SIZE_THRESHOLDS.oversizedCodeLines ||
    (commitCount !== null && commitCount > PR_SIZE_THRESHOLDS.oversizedCommits)
  ) {
    return "oversized";
  }
  if (
    codeLines >= PR_SIZE_THRESHOLDS.largeCodeLines ||
    (commitCount !== null && commitCount >= PR_SIZE_THRESHOLDS.largeCommits)
  ) {
    return "large";
  }
  if (
    codeLines >= PR_SIZE_THRESHOLDS.mediumCodeLines ||
    (commitCount !== null && commitCount >= PR_SIZE_THRESHOLDS.mediumCommits)
  ) {
    return "medium";
  }
  return "small";
}

function messageForTier(tier: PrSizeTier): string | null {
  if (tier === "medium") return "Smaller PRs improve scan quality.";
  if (tier === "large") return "Scan quality may degrade.";
  if (tier === "oversized") return "Split recommended.";
  return null;
}
