export interface FindingShape {
  filename: string;
  line: number | null;
  category: string;
  severity: string;
  [key: string]: unknown;
}

function identityTuple(f: FindingShape): string {
  return `${f.filename}|${f.line ?? ""}|${f.category}|${f.severity}`;
}

export function diffBlockerFixes(
  prior: FindingShape[],
  current: FindingShape[],
): FindingShape[] {
  const currentBlockers = current.filter((f) => f.severity === "blocker");
  const currentSet = new Set(currentBlockers.map(identityTuple));

  return prior.filter(
    (f) => f.severity === "blocker" && !currentSet.has(identityTuple(f)),
  );
}
