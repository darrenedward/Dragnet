import { isSecuritySensitive } from "./securitySensitive";
import type { ChunkPlan, DiffManifest, FileClassification } from "./types";

export const CHUNK_LINE_CAP = 600;
/**
 * Minimum useful chunk size. Chunks smaller than this are wasteful —
 * the LLM call overhead dwarfs the work. The greedy fill prevents
 * creating them; verifyChunkPlan flags any that slip through.
 *
 * Exception: the LAST chunk in a plan is allowed to be smaller
 * (it's the remainder after filling). Also exception: a single
 * file that exceeds CHUNK_LINE_CAP gets its own chunk regardless.
 */
export const MIN_USEFUL_CHUNK_LINES = 100;

/**
 * Runtime overrides for chunk sizing. Callers pass these when they
 * want to use values from `.dragnet/review-limits.json` instead of
 * the constants above. Omitted fields fall back to the constants —
 * so existing tests that don't pass options get the old behavior.
 */
export interface ChunkOptions {
  chunkLineCap?: number;
  minUsefulChunkLines?: number;
}

/**
 * Build a chunk plan from a diff manifest.
 *
 * Algorithm: sort + greedy fill.
 *
 *   1. Filter to code files (existing behavior — docs, lockfiles,
 *      generated, and vendor files are skipped).
 *   2. Sort by (packageKey, typeBucket, filename) so files in the
 *      same package + same type land next to each other. This is
 *      the locality guarantee the previous bucketing step provided,
 *      but with the crucial difference that spillover is allowed:
 *      a tiny file can ride along with a chunk that's already
 *      partially filled by its package-mates.
 *   3. Walk files greedily, filling each chunk up to chunkLineCap.
 *      A single file > cap gets its own chunk (preserves existing
 *      edge-case behavior for very large files).
 *
 * Previous implementation keyed chunks by `packageKey::typeBucket`,
 * which created singleton chunks whenever a file landed in a unique
 * bucket (.env.example in "other", package.json in "config", etc.).
 * Each singleton burned a full LLM scan with 16-iteration budget on
 * a 3-line input. The new algorithm folds those files into the next
 * chunk that has room, regardless of bucket.
 *
 * After building the plan, verifyChunkPlan runs invariants and logs
 * warnings if anything slipped through (conservation, cap enforcement,
 * no wasteful tiny chunks).
 */
export function chunkDiff(
  manifest: DiffManifest,
  repoConfiguredSecurityPaths: string[] = [],
  options: ChunkOptions = {},
): ChunkPlan[] {
  const cap = options.chunkLineCap ?? CHUNK_LINE_CAP;
  const minUseful = options.minUsefulChunkLines ?? MIN_USEFUL_CHUNK_LINES;
  const codeFiles = manifest.files
    .filter((file) => file.fileClass === "code")
    .sort(compareFiles);

  const groups: FileClassification[][] = [];
  let current: FileClassification[] = [];
  let currentLines = 0;

  for (const file of codeFiles) {
    if (file.lineCount > cap) {
      // Oversized single file — flush current then give it its own chunk.
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentLines = 0;
      }
      groups.push([file]);
      continue;
    }
    if (current.length > 0 && currentLines + file.lineCount > cap) {
      groups.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(file);
    currentLines += file.lineCount;
  }
  if (current.length > 0) groups.push(current);

  const plans = groups.map((group, i) => toPlan(i + 1, group, repoConfiguredSecurityPaths));

  const issues = verifyChunkPlan(plans, codeFiles, options);
  if (issues.length > 0) {
    console.warn(`[chunker] plan invariants violated: ${issues.join("; ")}`);
  }

  return plans;
}

/**
 * Verify a chunk plan meets invariants. Returns an array of issue
 * descriptions — empty array means the plan is clean.
 *
 * Invariants:
 *   1. Conservation: every input code file appears in exactly one chunk.
 *   2. Cap enforcement: no chunk exceeds chunkLineCap, unless the
 *      chunk contains a single oversized file.
 *   3. No waste: no chunk (except possibly the last, or a single
 *      oversized file) is smaller than minUsefulChunkLines.
 *
 * Called at runtime from chunkDiff for dev-mode warnings. Used in
 * tests to lock in expectations and catch regressions.
 */
export function verifyChunkPlan(
  plans: ChunkPlan[],
  codeFiles: FileClassification[],
  options: ChunkOptions = {},
): string[] {
  const cap = options.chunkLineCap ?? CHUNK_LINE_CAP;
  const minUseful = options.minUsefulChunkLines ?? MIN_USEFUL_CHUNK_LINES;
  const issues: string[] = [];

  // 1) Conservation — every code file appears exactly once.
  const seen = new Map<string, number>();
  for (const file of codeFiles) seen.set(file.filename, 0);
  for (const plan of plans) {
    for (const file of plan.files) {
      seen.set(file.filename, (seen.get(file.filename) ?? 0) + 1);
    }
  }
  for (const [filename, count] of seen) {
    if (count === 0) issues.push(`file dropped: ${filename}`);
    else if (count > 1) issues.push(`file duplicated ${count}×: ${filename}`);
  }
  // Also check no chunk carries files outside the input set.
  const inputSet = new Set(codeFiles.map((f) => f.filename));
  for (const plan of plans) {
    for (const file of plan.files) {
      if (!inputSet.has(file.filename)) {
        issues.push(`chunk ${plan.id} carries unknown file: ${file.filename}`);
      }
    }
  }

  // 2) Cap enforcement.
  for (const plan of plans) {
    if (plan.lineCount <= cap) continue;
    if (plan.files.length === 1) continue; // oversized single file — OK
    issues.push(
      `chunk ${plan.id} exceeds cap: ${plan.lineCount} > ${cap} across ${plan.files.length} files`,
    );
  }

  // 3) No tiny chunks (except last + single oversized).
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (plan.lineCount >= minUseful) continue;
    if (i === plans.length - 1) continue; // last chunk is the remainder
    if (plan.files.length === 1 && plan.files[0].lineCount > cap) continue;
    issues.push(
      `chunk ${plan.id} is wastefully small: ${plan.lineCount} lines (cap=${cap}, min=${minUseful})`,
    );
  }

  return issues;
}

function toPlan(
  index: number,
  files: FileClassification[],
  repoConfiguredSecurityPaths: string[],
): ChunkPlan {
  const filePaths = files.map((file) => file.filename).sort();
  // Label: if the chunk is a single file, use its path; otherwise derive
  // a label from the dominant package + type. The previous implementation
  // labeled by bucket which was unique per chunk; with greedy fill,
  // chunks can span packages, so we pick the mode.
  const suffix = files.length === 1
    ? filePaths[0]
    : dominantKey(files);
  return {
    id: `chunk-${String(index).padStart(3, "0")}`,
    label: suffix,
    files,
    filePaths,
    lineCount: files.reduce((sum, file) => sum + file.lineCount, 0),
    touchesSecuritySensitive: filePaths.some((filePath) => isSecuritySensitive(filePath, repoConfiguredSecurityPaths)),
  };
}

/**
 * Pick the most common (packageKey, typeBucket) pair in the chunk as
 * the label. Ties broken alphabetically for determinism.
 */
function dominantKey(files: FileClassification[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = `${file.packageKey}/${file.typeBucket}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best || "mixed";
}

function compareFiles(a: FileClassification, b: FileClassification): number {
  return a.packageKey.localeCompare(b.packageKey)
    || a.typeBucket.localeCompare(b.typeBucket)
    || a.filename.localeCompare(b.filename);
}
