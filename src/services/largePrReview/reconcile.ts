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

  if (currentFindings.length === 0 && priorFindings.length === 0) {
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
        result.regressions++;
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
