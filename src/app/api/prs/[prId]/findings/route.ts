import { NextResponse } from "next/server";
import {
  getActiveScan,
  getLatestCompletedReview,
  getLatestTerminalReview,
  getRecentRuns,
} from "@/src/lib/reviewFreshness";
import { computeStability, computeWeightedStability } from "@/src/lib/stabilityScore";
import { lookupTrustWeight } from "@/src/lib/modelTrustWeights";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";
import { prisma } from "@/src/lib/prisma";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";
import { getLatestScanJobForPr, getScanJobForPr } from "@/src/services/scanQueue";
import { isMergeReady, mergeReadyLabel } from "@/src/lib/mergeReady";
import { parseScanGate } from "@/src/lib/scanPrelude";
import {
  classifyScanTerminalOutcome,
  providerOutcomesFromTokensUsed,
} from "@/src/lib/scanTerminalOutcome";
import { readLimits } from "@/src/lib/prSizeConfig";
import { readDurableScanEvidence } from "@/src/services/durableScanState";

const CHUNK_SELECT = {
  id: true,
  label: true,
  filePaths: true,
  status: true,
  skipReason: true,
  rating: true,
  summary: true,
  errorMessage: true,
  lineCount: true,
  touchesSecuritySensitive: true,
  startedAt: true,
  completedAt: true,
} as const;

/**
 * GET /api/prs/[prId]/findings
 *
 * Returns three views of the PR's review state:
 *
 * - `reviewRun` + `findings` + `chunks`: the latest COMPLETED run (the
 *   "current report"). Findings are filtered to exclude verifier-rejected.
 *   `chunks` are the per-chunk results for that completed run.
 * - `activeScan` + `activeChunks` + `activeFindings` + `activeIterations`:
 *   the currently in-progress run, if any. Lets the UI render live chunk
 *   progress, partial findings ("found so far"), and per-chunk iteration
 *   counts ("we're on round N") while the agentic loop is still running.
 *   Null/empty when no scan is active.
 * - `sizeProfile`: tier (normal/large/oversized) for the PR's current diff.
 *
 * `stale` is true when the completed run no longer matches the PR tip
 * commit and/or the current PrFile diff. `staleReason` is
 * `tip_mismatch` | `diff_changed` when stale.
 */
export async function GET(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: findings expose review content for the PR. proxy.ts
  // only checks cookie PRESENCE — validate the session against the DB.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const { prId } = await params;
    const prScopeErr = await enforcePrRepoScope(auth, prId);
    if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });

    const [latest, terminal, pr, files, activeScan, queueJob, latestJob] = await Promise.all([
      getLatestCompletedReview(prId),
      getLatestTerminalReview(prId),
      prisma.pullRequest.findUnique({
        where: { id: prId },
        select: {
          status: true,
          sourceBranch: true,
          targetBranch: true,
          repository: {
            select: {
              id: true,
              path: true,
              baseBranch: true,
              cloneUrl: true,
              cloneUrlHttps: true,
              deployKeyCipher: true,
              deployKeyIv: true,
              deployKeyTag: true,
              patCipher: true,
              patIv: true,
              patTag: true,
              maxConcurrentScans: true,
            },
          },
        },
      }),
      prisma.prFile.findMany({
        where: { prId },
        select: { filename: true, additions: true, deletions: true },
      }),
      getActiveScan(prId),
      getScanJobForPr(prId),
      getLatestScanJobForPr(prId),
    ]);
    const limits = readLimits();
    const terminalRun = terminal.reviewRun;
    const terminalOutcome = classifyScanTerminalOutcome({
      prStatus: pr?.status,
      runStatus: activeScan.reviewRun
        ? "in_progress"
        : terminalRun?.status ?? latest.reviewRun?.status,
      runOutcome: terminalRun?.outcome ?? latest.reviewRun?.outcome,
      rating: terminalRun?.rating ?? latest.reviewRun?.rating,
      systemWarn: terminalRun?.systemWarn ?? null,
      terminalClass: terminalRun?.terminalClass ?? null,
      blockedGate:
        !queueJob && latestJob?.state === "failed"
          ? parseScanGate(latestJob.errorMessage)
          : null,
      queueState: queueJob?.state ?? null,
      queuePosition: queueJob?.queuePosition ?? null,
      queueSlots: {
        globalLimit: limits.maxConcurrentScans,
        repoLimit: pr?.repository?.maxConcurrentScans ?? null,
      },
      providerOutcomes: providerOutcomesFromTokensUsed(
        terminalRun?.tokensUsed ?? latest.reviewRun?.tokensUsed,
      ),
    });
    // Active queue work is never "blocked finished." Terminal failed jobs may
    // carry a prelude gate code so the UI can show Blocked at {gate}.
    const blockedGate =
      !queueJob && latestJob?.state === "failed"
        ? parseScanGate(latestJob.errorMessage)
        : null;
    const commitCount = pr
      ? await readPrCommitCount(
          pr.repository,
          pr.targetBranch || pr.repository.baseBranch || "main",
          pr.sourceBranch,
        )
      : null;
    const sizeProfile = computePrSizeProfile(files, commitCount);

    const chunks = latest.reviewRun
      ? await prisma.reviewChunk.findMany({
          where: { reviewRunId: latest.reviewRun.id },
          orderBy: { id: "asc" },
          select: CHUNK_SELECT,
        })
      : [];

    const activeChunks = activeScan.reviewRun
      ? await prisma.reviewChunk.findMany({
          where: { reviewRunId: activeScan.reviewRun.id },
          orderBy: { id: "asc" },
          select: CHUNK_SELECT,
        })
      : [];

    const activeScanView = activeScan.reviewRun
      ? {
          id: activeScan.reviewRun.id,
          prId: activeScan.reviewRun.prId,
          commitHash: activeScan.reviewRun.commitHash,
          diffHash: activeScan.reviewRun.diffHash,
          startedAt: activeScan.reviewRun.startedAt,
          triggerReason: activeScan.reviewRun.triggerReason,
          model: activeScan.reviewRun.model,
          chunksTotal: activeScan.reviewRun.chunksTotal,
          chunksCompleted: activeScan.reviewRun.chunksCompleted,
          chunksFailed: activeScan.reviewRun.chunksFailed,
          chunksSkipped: activeScan.reviewRun.chunksSkipped,
        }
      : null;

    // Active partial findings + iteration map. Empty when no scan active.
    // Returned alongside the completed-run findings so the UI can render
    // "found so far" while scanning, then swap to the final list on done.
    const activeFindings = activeScan.findings;
    const activeIterations = activeScan.iterationsByChunk;
    const evidenceRunId = activeScan.reviewRun?.id ?? terminalRun?.id ?? latest.reviewRun?.id ?? null;
    const durableEvidence = evidenceRunId
      ? await readDurableScanEvidence(evidenceRunId)
      : { providerAttempts: [], artifacts: [], checkpoints: [] };

    if (!latest.reviewRun) {
      const noRun = isMergeReady(
        terminalOutcome.isFailed
          ? {
              status: "failed",
              outcome: null,
              rating: null,
            }
          : null,
      );
      return NextResponse.json({
        reviewRun: terminalRun
          ? {
              id: terminalRun.id,
              commitHash: terminalRun.commitHash,
              diffHash: terminalRun.diffHash,
              completedAt: terminalRun.completedAt,
              rating: terminalRun.rating,
              model: terminalRun.model,
              triggerReason: terminalRun.triggerReason,
              reliability: terminalRun.reliability,
              refused: terminalRun.refused,
              refusalNote: terminalRun.refusalNote,
              status: terminalRun.status,
              outcome: terminalRun.outcome,
              terminalClass: terminalRun.terminalClass,
              systemWarn: terminalRun.systemWarn,
              chunksTotal: terminalRun.chunksTotal,
              chunksCompleted: terminalRun.chunksCompleted,
              chunksFailed: terminalRun.chunksFailed,
              chunksSkipped: terminalRun.chunksSkipped,
              tokensUsed: terminalRun.tokensUsed ?? null,
            }
          : null,
        findings: [],
        rejectedFindings: [],
        rejectedCount: 0,
        regressions: [],
        stale: terminal.stale,
        staleReason: terminal.staleReason,
        mergeReady: noRun.mergeReady,
        mergeBlockReason: noRun.mergeBlockReason,
        mergeReadyMessage: blockedGate
          ? mergeReadyLabel(noRun, blockedGate)
          : noRun.message,
        blockedGate,
        terminalOutcome,
        outcomeClass: terminalOutcome.class,
        systemWarn: terminalOutcome.systemWarn,
        sizeProfile,
        stability: null,
        weightedStability: null,
        chunks,
        activeScan: activeScanView,
        activeChunks,
        activeFindings,
        activeIterations,
        durableEvidence,
        queueJob,
        message: blockedGate
          ? mergeReadyLabel(noRun, blockedGate)
          : terminalOutcome.isFailed
            ? terminalOutcome.reason
            : "No completed review yet. Run a scan.",
      });
    }

    const ratingTrend = await getRecentRuns(prId, 5);
    const stability = computeStability(ratingTrend);
    const weighted = computeWeightedStability(ratingTrend, lookupTrustWeight);
    // Prefer terminal run for status honesty when the latest terminal is a
    // failed rescan (do not let prior completed green mask the failure).
    const statusRun =
      terminalRun &&
      (terminalRun.status === "failed" ||
        terminalRun.id === latest.reviewRun.id ||
        (terminalRun.completedAt &&
          latest.reviewRun.completedAt &&
          terminalRun.completedAt >= latest.reviewRun.completedAt))
        ? terminalRun
        : latest.reviewRun;

    const merge = isMergeReady({
      rating: statusRun.status === "failed" ? null : latest.reviewRun.rating,
      outcome: statusRun.status === "failed" ? null : latest.reviewRun.outcome,
      reliability: statusRun.status === "failed" ? null : latest.reviewRun.reliability,
      refused: statusRun.status === "failed" ? false : latest.reviewRun.refused,
      stale: latest.stale,
      staleReason: latest.staleReason,
      status: statusRun.status === "failed" ? "failed" : latest.reviewRun.status,
      chunksTotal: statusRun.chunksTotal,
      chunksCompleted: statusRun.chunksCompleted,
      chunksFailed: statusRun.chunksFailed,
      chunksSkipped: statusRun.chunksSkipped,
    });

    return NextResponse.json({
      weightedStability: weighted.weightedStability,
      weightedReadyToMerge: weighted.readyToMerge,
      mergeReady: merge.mergeReady,
      mergeBlockReason: merge.mergeBlockReason,
      mergeReadyMessage: blockedGate
        ? mergeReadyLabel(merge, blockedGate)
        : merge.message,
      blockedGate,
      terminalOutcome,
      outcomeClass: terminalOutcome.class,
      systemWarn: terminalOutcome.systemWarn ?? statusRun.systemWarn ?? null,
      reviewRun: {
        id: statusRun.id,
        commitHash: statusRun.commitHash,
        diffHash: statusRun.diffHash,
        completedAt: statusRun.completedAt,
        rating: statusRun.rating,
        model: statusRun.model,
        triggerReason: statusRun.triggerReason,
        reliability: statusRun.reliability,
        refused: statusRun.refused,
        refusalNote: statusRun.refusalNote,
        status: statusRun.status,
        outcome: statusRun.outcome,
        terminalClass: statusRun.terminalClass,
        systemWarn: statusRun.systemWarn,
        chunksTotal: statusRun.chunksTotal,
        chunksCompleted: statusRun.chunksCompleted,
        chunksFailed: statusRun.chunksFailed,
        chunksSkipped: statusRun.chunksSkipped,
        tokensUsed: statusRun.tokensUsed ?? null,
      },
      findings: statusRun.status === "failed" && statusRun.id !== latest.reviewRun.id
        ? latest.findings
        : latest.findings,
      rejectedFindings: latest.rejectedFindings,
      rejectedCount: latest.rejectedCount,
      regressions: latest.regressions,
      stale: latest.stale || terminal.stale,
      staleReason: latest.staleReason ?? terminal.staleReason,
      stability,
      sizeProfile,
      chunks,
      activeScan: activeScanView,
      activeChunks,
      activeFindings,
      activeIterations,
      durableEvidence,
      queueJob,
    });
  } catch (err: any) {
    console.error("Error fetching findings for PR:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
