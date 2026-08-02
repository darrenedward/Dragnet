/**
 * Conservative root-cause cluster planner.
 *
 * After fingerprint intra-run dedupe, high-confidence findings that clearly
 * share one root cause (same category + normalized explanation stem) but land
 * at different locations can merge into a single multi-location finding.
 *
 * Conservative defaults:
 *  - low/missing confidence → no merge
 *  - different categories → no merge
 *  - weak/empty stems → no merge
 *  - never silent-drop: merge keeps one survivor and attaches sibling locations
 */

export interface ClusterFinding {
  id: string;
  fingerprint: string;
  category: string;
  severity: string;
  filename: string;
  line: number | null;
  explanation: string;
  confidence: number | null;
  evidenceChain: string | null;
}

export interface ClusterLocation {
  file: string;
  line: number | null;
  text: string;
}

export interface ClusterGroup {
  /** Surviving finding id (highest confidence, then severity, then earliest id). */
  keepId: string;
  /** All member ids including keepId. */
  memberIds: string[];
  /** Locations covered by the cluster (primary + siblings). */
  multiLocation: ClusterLocation[];
  /** JSON-serializable evidence chain for the survivor. */
  mergedEvidenceChain: ClusterLocation[];
  /** True when merge changed locations/evidence vs the keep row alone. */
  shouldReverify: boolean;
  rootCauseKey: string;
}

export interface ClusterPlanOptions {
  /** Minimum confidence required on every member (default 0.85). */
  minConfidence?: number;
  /** Minimum normalized stem length (default 24). */
  minStemLength?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.85;
const DEFAULT_MIN_STEM_LENGTH = 24;

const SEVERITY_RANK: Record<string, number> = {
  blocker: 3,
  warning: 2,
  suggestion: 1,
};

/**
 * Normalize an explanation into a stable root-cause key.
 * Strips paths, line refs, and punctuation noise so cross-chunk wording
 * that describes the same bug collapses.
 */
export function rootCauseKey(explanation: string): string {
  // Strip location noise before sentence split so `src/foo.ts:12` is not
  // treated as a sentence boundary on the extension dot.
  const cleaned = (explanation || "")
    .toLowerCase()
    .replace(/(?:[\w@.-]+\/)+[\w.-]+\.[a-z0-9]+(?::\d+)?/g, " ")
    .replace(/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs)\b(?::\d+)?/g, " ")
    .replace(/\b(?:line|lines|at|@)\s*\d+\b/g, " ")
    .replace(/:\d+(?::\d+)?/g, " ")
    .replace(/`[^`]+`/g, " ");
  const firstSentence = cleaned.split(/(?:[.!?]\s+|\n)/)[0] || cleaned;
  return firstSentence
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function rankFinding(a: ClusterFinding, b: ClusterFinding): number {
  const confDelta = (b.confidence ?? -1) - (a.confidence ?? -1);
  if (confDelta !== 0) return confDelta;
  const sevDelta = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
  if (sevDelta !== 0) return sevDelta;
  return a.id.localeCompare(b.id);
}

function parseEvidence(raw: string | null): ClusterLocation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        file: String(item?.file ?? item?.filename ?? ""),
        line: typeof item?.line === "number" ? item.line : null,
        text: String(item?.text ?? item?.note ?? "").slice(0, 300),
      }))
      .filter((loc) => loc.file.length > 0);
  } catch {
    return [];
  }
}

function locationKey(loc: ClusterLocation): string {
  return `${loc.file}:${loc.line ?? "?"}`;
}

/**
 * Pure planner: finding ids → groups with keep + members + multi-location payload.
 * Returns only groups with 2+ members (actionable merges). Singletons omitted.
 */
export function planRootCauseClusters(
  findings: ClusterFinding[],
  options: ClusterPlanOptions = {},
): ClusterGroup[] {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minStemLength = options.minStemLength ?? DEFAULT_MIN_STEM_LENGTH;

  const eligible = findings.filter((f) => {
    if (f.confidence == null || f.confidence < minConfidence) return false;
    const key = rootCauseKey(f.explanation);
    return key.length >= minStemLength;
  });

  const buckets = new Map<string, ClusterFinding[]>();
  for (const f of eligible) {
    const key = `${f.category.toLowerCase()}::${rootCauseKey(f.explanation)}`;
    const group = buckets.get(key) ?? [];
    group.push(f);
    buckets.set(key, group);
  }

  const groups: ClusterGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;

    // Distinct locations required — same-location pairs are fingerprint work.
    const byLocation = new Map<string, ClusterFinding>();
    for (const m of members) {
      const loc = `${m.filename}:${m.line ?? "?"}`;
      const existing = byLocation.get(loc);
      if (!existing || rankFinding(m, existing) < 0) {
        byLocation.set(loc, m);
      }
    }
    const distinct = [...byLocation.values()];
    if (distinct.length < 2) continue;

    const sorted = [...distinct].sort(rankFinding);
    const keep = sorted[0];
    // Collapse the whole bucket (including same-location losers that lost the
    // per-location rank). Distinct locations only gate whether a merge is
    // warranted; orphans must not remain as separate published findings.
    const memberIds = members.map((m) => m.id);
    const multiLocation: ClusterLocation[] = sorted.map((m) => ({
      file: m.filename,
      line: m.line,
      text: m.explanation.slice(0, 300),
    }));

    const evidenceMap = new Map<string, ClusterLocation>();
    for (const m of sorted) {
      const primary: ClusterLocation = {
        file: m.filename,
        line: m.line,
        text: m.explanation.slice(0, 300),
      };
      evidenceMap.set(locationKey(primary), primary);
      for (const loc of parseEvidence(m.evidenceChain)) {
        if (!evidenceMap.has(locationKey(loc))) {
          evidenceMap.set(locationKey(loc), loc);
        }
      }
    }

    groups.push({
      keepId: keep.id,
      memberIds,
      multiLocation,
      mergedEvidenceChain: [...evidenceMap.values()],
      shouldReverify: true,
      rootCauseKey: key,
    });
  }

  return groups;
}

/**
 * Ids that should be deleted after applying cluster merges (all non-keep members).
 */
export function clusterDuplicateIds(groups: ClusterGroup[]): string[] {
  const ids: string[] = [];
  for (const g of groups) {
    for (const id of g.memberIds) {
      if (id !== g.keepId) ids.push(id);
    }
  }
  return ids;
}
