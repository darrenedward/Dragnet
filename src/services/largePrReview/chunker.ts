import { isSecuritySensitive } from "./securitySensitive";
import type { ChunkPlan, DiffManifest, FileClassification } from "./types";

export const CHUNK_LINE_CAP = 600;

export function chunkDiff(
  manifest: DiffManifest,
  repoConfiguredSecurityPaths: string[] = [],
): ChunkPlan[] {
  const codeFiles = manifest.files
    .filter((file) => file.fileClass === "code")
    .sort(compareFiles);
  const bucketMap = new Map<string, FileClassification[]>();
  for (const file of codeFiles) {
    const key = `${file.packageKey}::${file.typeBucket}`;
    bucketMap.set(key, [...(bucketMap.get(key) || []), file]);
  }

  const plans: ChunkPlan[] = [];
  const keys = [...bucketMap.keys()].sort();
  for (const key of keys) {
    const files = (bucketMap.get(key) || []).sort(compareFiles);
    for (const group of splitByLineCap(files)) {
      plans.push(toPlan(plans.length + 1, key, group, repoConfiguredSecurityPaths));
    }
  }
  return plans;
}

function splitByLineCap(files: FileClassification[]): FileClassification[][] {
  const groups: FileClassification[][] = [];
  let current: FileClassification[] = [];
  let currentLines = 0;

  for (const file of files) {
    if (file.lineCount > CHUNK_LINE_CAP) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentLines = 0;
      }
      groups.push([file]);
      continue;
    }
    if (current.length > 0 && currentLines + file.lineCount > CHUNK_LINE_CAP) {
      groups.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(file);
    currentLines += file.lineCount;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function toPlan(
  index: number,
  key: string,
  files: FileClassification[],
  repoConfiguredSecurityPaths: string[],
): ChunkPlan {
  const [pkg, type] = key.split("::");
  const filePaths = files.map((file) => file.filename).sort();
  const suffix = files.length === 1 ? filePaths[0] : `${pkg}/${type}`;
  return {
    id: `chunk-${String(index).padStart(3, "0")}`,
    label: suffix,
    files,
    filePaths,
    lineCount: files.reduce((sum, file) => sum + file.lineCount, 0),
    touchesSecuritySensitive: filePaths.some((filePath) => isSecuritySensitive(filePath, repoConfiguredSecurityPaths)),
  };
}

function compareFiles(a: FileClassification, b: FileClassification): number {
  return a.packageKey.localeCompare(b.packageKey) ||
    a.typeBucket.localeCompare(b.typeBucket) ||
    a.filename.localeCompare(b.filename);
}
