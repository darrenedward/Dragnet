export interface FindingShape {
  filename: string;
  line: number | null;
  category: string;
  severity: string;
}

export function identityTuple(f: FindingShape): string {
  return `${f.filename}|${f.line ?? ""}|${f.category}|${f.severity}`;
}

export function diffResolvedFindings(
  prior: FindingShape[],
  current: FindingShape[],
): FindingShape[] {
  const currentSet = new Set(current.map(identityTuple));

  return prior.filter((f) => !currentSet.has(identityTuple(f)));
}

/** @deprecated Use diffResolvedFindings for all finding severities. */
export function diffBlockerFixes(
  prior: FindingShape[],
  current: FindingShape[],
): FindingShape[] {
  return diffResolvedFindings(
    prior.filter((finding) => finding.severity === "blocker"),
    current.filter((finding) => finding.severity === "blocker"),
  );
}
