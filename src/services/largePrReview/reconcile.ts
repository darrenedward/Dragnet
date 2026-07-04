import { prisma } from "@/src/lib/prisma";
import { resolveSymbolsBatch } from "./fingerprint";

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

export interface RegressionPlan {
  regressions: Array<{
    currentFindingId: string;
    regressedFromRunId: string;
  }>;
  falsePositiveRecoveries: string[];
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
      currentByFp.delete(prior.fingerprint);
    } else {
      unmatchedPriorIds.push(prior.id);
    }
  }

  return { matchedNewIds, matchedPriorUpdates, unmatchedPriorIds };
}

/**
 * Pure-function regression detector. Given the genuinely new findings (those
 * not matched to any OPEN prior) and the prior RESOLVED findings, determine
 * which are regressions and which are false-positive recoveries.
 *
 * A finding is a regression when a resolved finding with the same fingerprint
 * exists AND the code at the anchor point has changed since resolution
 * (prior.sourceHashAtInsert !== current.sourceHashAtInsert).
 *
 * A finding is a false-positive recovery when the sourceHash matches the prior
 * resolved finding — meaning the "resolution" was spurious (code never changed,
 * LLM just stopped reporting it).
 *
 * Pure so it can be tested without a database.
 */
export function detectRegressions(
  newFindings: Array<{
    id: string;
    fingerprint: string | null;
    sourceHashAtInsert: string | null;
  }>,
  priorResolved: Array<{
    fingerprint: string | null;
    sourceHashAtInsert: string | null;
    resolvedAtRunId: string | null;
  }>,
): RegressionPlan {
  const resolvedByFp = new Map<string, (typeof priorResolved)[number]>();
  for (const r of priorResolved) {
    if (r.fingerprint && !resolvedByFp.has(r.fingerprint)) {
      resolvedByFp.set(r.fingerprint, r);
    }
  }

  const regressions: Array<{ currentFindingId: string; regressedFromRunId: string }> = [];
  const falsePositiveRecoveries: string[] = [];

  for (const f of newFindings) {
    if (!f.fingerprint) continue;
    const prior = resolvedByFp.get(f.fingerprint);
    if (!prior) continue;

    if (prior.resolvedAtRunId && prior.sourceHashAtInsert !== f.sourceHashAtInsert) {
      regressions.push({
        currentFindingId: f.id,
        regressedFromRunId: prior.resolvedAtRunId,
      });
    } else {
      falsePositiveRecoveries.push(f.id);
    }
  }

  return { regressions, falsePositiveRecoveries };
}

/**
 * Cross-run finding reconciliation. After a scan (and intra-run dedup), match
 * the current run's findings against prior OPEN findings for the same PR by
 * fingerprint. Then check genuinely new findings against prior RESOLVED findings
 * to detect regressions.
 *
 *   Match by fingerprint      → bump prior.lastSeenRunId + snapshot, delete the new duplicate.
 *   No match, resolved prior  → detectRegression: flag isRegression or false-positive recovery.
 *   No match, no prior        → leave the new finding as-is.
 *   Prior with no match       → compare current symbol.sourceHash to snapshot:
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

  const priorOpenFindings = await prisma.reviewFinding.findMany({
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

  const priorResolvedFindings = await prisma.reviewFinding.findMany({
    where: {
      prId,
      status: "resolved",
      lastSeenRunId: { not: currentRunId },
    },
    select: {
      fingerprint: true,
      sourceHashAtInsert: true,
      resolvedAtRunId: true,
    },
  });

  if (currentFindings.length === 0 && priorOpenFindings.length === 0 && priorResolvedFindings.length === 0) {
    return result;
  }

  // Phase 1: match current vs prior OPEN findings by fingerprint
  const plan = planReconcile(currentFindings, priorOpenFindings);
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

  // Phase 2: check genuinely new findings against prior RESOLVED findings
  if (priorResolvedFindings.length > 0 && result.newFindings > 0) {
    const genuinelyNew = currentFindings.filter((f) =>
      !plan.matchedNewIds.includes(f.id),
    );
    const regressionPlan = detectRegressions(genuinelyNew, priorResolvedFindings);

    if (regressionPlan.regressions.length > 0) {
      for (const r of regressionPlan.regressions) {
        await prisma.reviewFinding.update({
          where: { id: r.currentFindingId },
          data: {
            isRegression: true,
            regressedFromRunId: r.regressedFromRunId,
          },
        });
      }
      result.regressions = regressionPlan.regressions.length;
    }

    if (regressionPlan.falsePositiveRecoveries.length > 0) {
      await prisma.reviewFinding.deleteMany({
        where: { id: { in: regressionPlan.falsePositiveRecoveries } },
      });
    }
  }

  // Phase 3: handle unmatched prior OPEN findings — resolve or warn
  if (plan.unmatchedPriorIds.length > 0) {
    const unmatchedPriors = priorOpenFindings.filter((p) =>
      plan.unmatchedPriorIds.includes(p.id),
    );
    const repoId = unmatchedPriors[0]!.repoId;
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

  return result;
}
