import { prisma } from "@/src/lib/prisma";
import { buildFindingFingerprint, resolveSymbolsBatch } from "./fingerprint";

export interface ReconcileResult {
  matched: number;
  resolved: number;
  regressions: number;
  newFindings: number;
}

export interface ReconcilePlan {
  matchedNewIds: string[];
  matchedPriorUpdates: Array<{
    id: string;
    sourceHashAtInsert: string | null;
  }>;
  unmatchedPriorIds: string[];
}

export interface RegressionFinding {
  currentFindingId: string;
  priorFindingId: string;
  regressedFromRunId: string;
}

export interface IntraRunDedupItem {
  id: string;
  fingerprint: string;
  severity: string;
  confidence: number | null;
  timestamp: string;
}

/**
 * Pure-function core of intra-run dedup. Given findings pre-fingerprinted
 * within a single run, group by fingerprint and return the IDs of duplicates
 * to delete (all but the highest-confidence, then highest-severity, then
 * earliest finding in each group).
 *
 * Pure so it can be tested without a database — matches the pattern of
 * planReconcile and detectRegressions.
 */
export function planIntraRunDedup(
  findings: IntraRunDedupItem[],
): string[] {
  const byFingerprint = new Map<string, IntraRunDedupItem[]>();
  for (const f of findings) {
    const group = byFingerprint.get(f.fingerprint) ?? [];
    group.push(f);
    byFingerprint.set(f.fingerprint, group);
  }

  const duplicateIds: string[] = [];
  for (const group of byFingerprint.values()) {
    if (group.length < 2) continue;
    const [keep, ...dupes] = [...group].sort((a, b) => {
      const confDelta = (b.confidence ?? -1) - (a.confidence ?? -1);
      if (confDelta !== 0) return confDelta;
      const sevDelta = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (sevDelta !== 0) return sevDelta;
      return a.timestamp.localeCompare(b.timestamp);
    });
    void keep;
    duplicateIds.push(...dupes.map((f) => f.id));
  }

  return duplicateIds;
}

const SEVERITY_RANK: Record<string, number> = {
  blocker: 3,
  warning: 2,
  suggestion: 1,
};

/**
 * Intra-run dedup: group findings within a single review run by fingerprint,
 * keep the highest-confidence (then highest-severity, then earliest) finding,
 * and delete the rest as duplicates.
 *
 * Moved from aggregator.ts to a shared home so regular (non-chunked) scans
 * also benefit from intra-run dedup. Exported so it can be imported by both
 * reviewService.ts and aggregator.ts.
 */
export async function dedupFindingsWithinRun(reviewRunId: string): Promise<number> {
  const findings = await prisma.reviewFinding.findMany({
    where: { reviewRunId },
    orderBy: [{ filename: "asc" }, { line: "asc" }, { timestamp: "asc" }],
    select: {
      id: true,
      repoId: true,
      filename: true,
      line: true,
      category: true,
      severity: true,
      confidence: true,
      timestamp: true,
    },
  });
  if (findings.length === 0) return 0;

  const repoId = findings[0].repoId;
  const symbolMap = await resolveSymbolsBatch(
    repoId,
    findings.map((f) => ({ filePath: f.filename, line: f.line })),
  );

  const fingerprinted: IntraRunDedupItem[] = findings.map((f) => {
    const resolution = symbolMap.get(`${f.filename}:${f.line ?? "?"}`);
    const symbolId = resolution?.symbolId ?? null;
    const fingerprint = buildFindingFingerprint({
      symbolId,
      filePath: f.filename,
      category: f.category,
    });
    return { id: f.id, fingerprint, severity: f.severity, confidence: f.confidence, timestamp: f.timestamp };
  });

  const duplicateIds = planIntraRunDedup(fingerprinted);
  if (duplicateIds.length > 0) {
    await prisma.reviewFinding.deleteMany({ where: { id: { in: duplicateIds } } });
  }
  return duplicateIds.length;
}

/**
 * Pure-function core of cross-run reconciliation. Given the current run's
 * findings and the prior OPEN findings for the same PR, return a plan: which
 * new findings are duplicates of priors (delete), which priors should be
 * "bumped" (lastSeenRunId + sourceHashAtInsert refresh), and which priors
 * are unmatched (need resolved-vs-regression classification).
 *
 * Pure so it can be tested without a database — matches the pattern in
 * tests/largePrMode/{chunker,manifest,tailSkip}.test.ts.
 */
export function planReconcile(
  currentFindings: Array<{
    id: string;
    fingerprint: string | null;
    sourceHashAtInsert: string | null;
  }>,
  priorFindings: Array<{
    id: string;
    fingerprint: string | null;
  }>,
): ReconcilePlan {
  const currentByFp = new Map<string, (typeof currentFindings)[number]>();
  for (const f of currentFindings) {
    if (f.fingerprint) currentByFp.set(f.fingerprint, f);
  }

  const matchedNewIds: string[] = [];
  const matchedPriorUpdates: Array<{
    id: string;
    sourceHashAtInsert: string | null;
  }> = [];
  const unmatchedPriorIds: string[] = [];

  for (const prior of priorFindings) {
    if (!prior.fingerprint) {
      unmatchedPriorIds.push(prior.id);
      continue;
    }
    const match = currentByFp.get(prior.fingerprint);
    if (match) {
      matchedNewIds.push(match.id);
      matchedPriorUpdates.push({
        id: prior.id,
        sourceHashAtInsert: match.sourceHashAtInsert,
      });
      // Consume the match so a second prior with the same fingerprint can't
      // re-grab it. Defense-in-depth: intra-run dedup should already prevent
      // two priors from sharing a fingerprint, but legacy rows may not.
      currentByFp.delete(prior.fingerprint);
    } else {
      unmatchedPriorIds.push(prior.id);
    }
  }

  return { matchedNewIds, matchedPriorUpdates, unmatchedPriorIds };
}

/**
 * Detect regressions — findings that were previously resolved on a symbol but
 * have reappeared with the same fingerprint in a new run. A regression is
 * flagged when:
 *   - A new finding's fingerprint matches a prior RESOLVED finding
 *   - AND the sourceHash has changed (code at anchor shifted)
 *
 * If sourceHash is unchanged, we treat it as false positive recovery (LLM
 * missed it last round) and do NOT flag as regression.
 *
 * Pure function — safe to unit-test without a database.
 *
 * Defense-in-depth: one current finding can match at most one prior (first
 * match wins, consumed). This prevents ambiguous regression links.
 */
export function detectRegressions(
  currentFindings: Array<{
    id: string;
    fingerprint: string | null;
    sourceHashAtInsert: string | null;
  }>,
  resolvedFindings: Array<{
    id: string;
    fingerprint: string | null;
    sourceHashAtInsert: string | null;
    resolvedAtRunId: string;
  }>,
): RegressionFinding[] {
  const regressions: RegressionFinding[] = [];
  const consumedCurrentIds = new Set<string>();

  for (const prior of resolvedFindings) {
    if (!prior.fingerprint) continue;

    // Find a matching current finding that hasn't been consumed
    const match = currentFindings.find((cur) => {
      if (consumedCurrentIds.has(cur.id)) return false;
      if (!cur.fingerprint || cur.fingerprint !== prior.fingerprint) return false;
      return true;
    });

    if (!match) continue;

    // Check if sourceHash changed (code at anchor shifted)
    const currentHash = match.sourceHashAtInsert;
    const priorHash = prior.sourceHashAtInsert;

    // Regression if: hashes differ OR either hash is null (conservative)
    const isRegression = currentHash !== priorHash || currentHash === null || priorHash === null;

    if (isRegression) {
      regressions.push({
        currentFindingId: match.id,
        priorFindingId: prior.id,
        regressedFromRunId: prior.resolvedAtRunId,
      });
      consumedCurrentIds.add(match.id);
    }
  }

  return regressions;
}

/**
 * Cross-run finding reconciliation. After a scan (and intra-run dedup), match
 * the current run's findings against prior OPEN findings for the same PR by
 * fingerprint. Preserves `firstSeenRunId` on match (so "open since R1" works
 * in the skill UI) and distinguishes "fixed" from "detection regression" using
 * the `sourceHashAtInsert` snapshot.
 *
 *   Match by fingerprint  → bump prior.lastSeenRunId + snapshot, delete the new duplicate.
 *   No match (new)        → leave the new finding as-is.
 *   Prior with no match   → compare current symbol.sourceHash to snapshot:
 *     changed  → mark resolved (code at the anchor shifted — likely the fix landed).
 *     unchanged → leave open, log warning (LLM missed it this round; will retry next scan).
 *
 * Idempotent: matched-new deletion only affects rows still tied to currentRunId.
 */
export async function reconcileFindingsAcrossRuns(
  prId: string,
  currentRunId: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    matched: 0,
    resolved: 0,
    regressions: 0,
    newFindings: 0,
  };

  const currentFindings = await prisma.reviewFinding.findMany({
    where: { prId, reviewRunId: currentRunId, status: "open" },
    select: { id: true, fingerprint: true, sourceHashAtInsert: true },
  });

  const priorFindings = await prisma.reviewFinding.findMany({
    where: {
      prId,
      status: "open",
      lastSeenRunId: { not: currentRunId },
    },
    select: {
      id: true,
      fingerprint: true,
      filename: true,
      line: true,
      sourceHashAtInsert: true,
      repoId: true,
    },
  });

  // Query resolved findings to detect regressions (findings that reappeared after being resolved)
  const resolvedFindings = await prisma.reviewFinding.findMany({
    where: {
      prId,
      status: "resolved",
      resolvedAtRunId: { not: null },
    },
    select: {
      id: true,
      fingerprint: true,
      sourceHashAtInsert: true,
      resolvedAtRunId: true,
    },
  });

  if (currentFindings.length === 0 && priorFindings.length === 0 && resolvedFindings.length === 0) {
    return result;
  }

  const plan = planReconcile(currentFindings, priorFindings);
  result.matched = plan.matchedPriorUpdates.length;
  result.newFindings = currentFindings.length - plan.matchedNewIds.length;

  for (const update of plan.matchedPriorUpdates) {
    await prisma.reviewFinding.update({
      where: { id: update.id },
      data: {
        lastSeenRunId: currentRunId,
        sourceHashAtInsert: update.sourceHashAtInsert,
      },
    });
  }
  if (plan.matchedNewIds.length > 0) {
    await prisma.reviewFinding.deleteMany({
      where: { id: { in: plan.matchedNewIds } },
    });
  }

  if (plan.unmatchedPriorIds.length > 0) {
    const unmatchedPriors = priorFindings.filter((p) =>
      plan.unmatchedPriorIds.includes(p.id),
    );
    const repoId = unmatchedPriors[0].repoId;
    const symbols = await resolveSymbolsBatch(
      repoId,
      unmatchedPriors.map((p) => ({ filePath: p.filename, line: p.line })),
    );

    const resolvedIds: string[] = [];
    for (const prior of unmatchedPriors) {
      const current = symbols.get(`${prior.filename}:${prior.line ?? "?"}`);
      const currentHash = current?.sourceHash ?? null;
      if (currentHash && prior.sourceHashAtInsert && currentHash !== prior.sourceHashAtInsert) {
        resolvedIds.push(prior.id);
      } else {
        console.warn(
          `[dedup] possible detection regression: prior finding ${prior.id} not re-detected but code at anchor unchanged`,
        );
      }
    }
    if (resolvedIds.length > 0) {
      await prisma.reviewFinding.updateMany({
        where: { id: { in: resolvedIds } },
        data: { status: "resolved", resolvedAtRunId: currentRunId },
      });
      result.resolved = resolvedIds.length;
    }
  }

  // Detect and persist regressions (resolved findings that reappeared)
  if (resolvedFindings.length > 0 && currentFindings.length > 0) {
    const regressions = detectRegressions(currentFindings, resolvedFindings);

    for (const regression of regressions) {
      await prisma.reviewFinding.update({
        where: { id: regression.currentFindingId },
        data: {
          isRegression: true,
          regressedFromRunId: regression.regressedFromRunId,
        },
      });
    }
    result.regressions = regressions.length;
  }

  return result;
}
