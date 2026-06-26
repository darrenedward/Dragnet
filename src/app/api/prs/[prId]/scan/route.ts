import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { IndexingService } from "@/src/services/indexingService";
import { getChatChain, getEmbeddingChain } from "@/src/lib/llmClient";
import { isReviewActive, beginReview, endReview } from "@/src/lib/reviewLocks";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  assertReviewFreshness,
  assertNoActiveScan,
  createReviewRun,
  completeReviewRun,
} from "@/src/lib/reviewFreshness";

export async function POST(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  const { prId } = await params;
  await req.json().catch(() => ({}));
  console.log(`[scan] route: POST received for prId=${prId}`);

  const force = new URL(req.url).searchParams.get("force") === "true";

  // Tracks whether THIS request acquired the review lock, so a failure
  // before acquisition never clears a concurrent scan's lock.
  let acquired = false;
  // Hoisted so the catch block can mark the run failed if runPrScan (or
  // anything between createReviewRun and the return) throws. Without this,
  // the run row stays in_progress forever and the next scan 409s with
  // SCAN_IN_PROGRESS — see reviewFreshness.ts:assertNoActiveScan.
  let reviewRunId: string | null = null;
  try {
    const chatChain = getChatChain();
    if (chatChain.length === 0) {
      return NextResponse.json({ error: "No primary chat model configured. Please go to LLM Settings and configure an endpoint (e.g., OpenRouter or Ollama) to enable PR scanning." }, { status: 400 });
    }

    const embedChain = getEmbeddingChain();
    if (embedChain.length === 0) {
      return NextResponse.json({ error: "No embedding model configured. Please go to LLM Settings and configure an embedding provider (e.g., mxbai-embed-large via local Ollama) to enable semantic codebase context." }, { status: 400 });
    }
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      select: { repoId: true, sourceBranch: true, targetBranch: true, commitHash: true },
    });
    if (!pr) {
      console.log(`[scan] route: PR ${prId} not found`);
      return NextResponse.json({ error: "PR not found." }, { status: 404 });
    }
    console.log(`[scan] route: PR found, repoId=${pr.repoId}, branch=${pr.sourceBranch}`);

    const repo = await prisma.repository.findUnique({
      where: { id: pr.repoId },
      select: { id: true, name: true, indexedAt: true, lastCommitHash: true, path: true, baseBranch: true },
    });
    if (!repo) {
      console.log(`[scan] route: repo not found for repoId=${pr.repoId}`);
      return NextResponse.json({ error: "Repository record not found." }, { status: 404 });
    }
    console.log(`[scan] route: repo=${repo.name}, indexedAt=${repo.indexedAt}, path=${repo.path}`);

    const freshness = assertIndexFresh(repo);
    if (freshness.ok === false) {
      console.log(`[scan] route: freshness not ok kind=${freshness.kind} message=${freshness.message}`);
      if (freshness.kind === "INDEX_REQUIRED") {
        console.log(`[scan] route: INDEX_REQUIRED - returning 409`);
        return NextResponse.json(
          { error: freshness.kind, message: freshness.message, repoId: pr.repoId },
          { status: 409 },
        );
      }
      console.log(`[scan] route: STALE_INDEX - triggering incremental index`);
      if (repo.path) {
        await IndexingService.indexFolder(pr.repoId, repo.path);
        console.log(`[scan] route: incremental index complete`);
      }
    } else {
      console.log(`[scan] route: freshness check OK (indexedAt=${repo.indexedAt})`);
    }

    // Refresh PR files BEFORE freshness check — diffHash needs the files
    // whether we hit cache or run the scan. Cheap if files haven't changed.
    const repoPath = repo.path;
    const baseBranch = pr.targetBranch || repo.baseBranch || "main";
    let files: any[] = [];
    if (repoPath && pr.sourceBranch) {
      console.log(`[scan] route: refreshing PR files from git`);
      files = await refreshPrFiles(repoPath, baseBranch, pr.sourceBranch, prId);
      console.log(`[scan] route: got ${files.length} files`);
    } else {
      console.log(`[scan] route: no repoPath or sourceBranch - skipping file refresh`);
    }

    // Review freshness guard. If a completed ReviewRun exists for the same
    // (commitHash, diffHash, reviewConfigHash), short-circuit and return the
    // cached findings. `force=true` bypasses.
    const currentDiffHash = computeDiffHash(files);
    const currentConfigHash = computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION));
    console.log(`[scan] route: diffHash=${currentDiffHash.slice(0, 8) || "(empty)"}, configHash=${currentConfigHash.slice(0, 8)}, force=${force}`);

    if (!force) {
      const fresh = await assertReviewFreshness(
        { id: prId, commitHash: pr.commitHash },
        currentDiffHash,
        currentConfigHash,
      );
      if (fresh.ok === true) {
        console.log(`[scan] route: cache HIT on runId=${fresh.runId} — short-circuiting`);
        const findings = await prisma.reviewFinding.findMany({
          where: {
            reviewRunId: fresh.runId,
            OR: [
              { verificationStatus: null },
              { verificationStatus: { not: "rejected" } },
            ],
          },
          select: { id: true, category: true, severity: true, filename: true, line: true, explanation: true, diffSuggestion: true, evidenceChain: true, confidence: true, verificationStatus: true, verificationNote: true, timestamp: true },
        });
        return NextResponse.json({
          cached: true,
          runId: fresh.runId,
          rating: fresh.rating,
          findings,
          usedModel: null,
        });
      }
      // fresh.ok === false → narrowed to STALE_RUN / NO_RUN
      console.log(`[scan] route: cache MISS — running scan`);
    }

    // Concurrency guard — shared with the command/prcheck/prepush routes.
    // The in-memory isReviewActive check catches same-process races; the
    // DB-backed assertNoActiveScan catches cross-process races (another
    // worker, or a scan started via the /gloop skill while a UI scan runs).
    if (isReviewActive(prId)) {
      console.log(`[scan] route: in-memory lock says review already in progress for ${prId} — 409`);
      return NextResponse.json(
        { error: "A review is already in progress for this PR. Wait for it to finish before re-scanning." },
        { status: 409 },
      );
    }
    const activeScan = await assertNoActiveScan(prId, force);
    if (activeScan.ok === false) {
      console.log(`[scan] route: DB says scan ${activeScan.runId} already in progress for ${prId} — 409`);
      return NextResponse.json(
        {
          error: "SCAN_IN_PROGRESS",
          runId: activeScan.runId,
          startedAt: activeScan.startedAt,
          triggerReason: activeScan.triggerReason,
          model: activeScan.model,
          message: `Scan already running (started ${activeScan.startedAt.toISOString()}). Use ?force=true to override.`,
        },
        { status: 409 },
      );
    }
    beginReview(prId);
    acquired = true;

    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
    console.log(`[scan] route: status set to In Progress`);

    reviewRunId = await createReviewRun({
      prId,
      repoId: pr.repoId,
      commitHash: pr.commitHash,
      diffHash: currentDiffHash,
      reviewConfigHash: currentConfigHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "manual",
      forced: force,
    });
    console.log(`[scan] route: created in_progress ReviewRun ${reviewRunId}`);

    console.log(`[scan] route: calling runPrScan with ${files.length} files`);
    const result = await runPrScan(prId, files, reviewRunId);
    console.log(`[scan] route: runPrScan complete - rating=${result.rating}, findings=${result.findings?.length}, model=${result.usedModel}`);

    if (acquired) endReview(prId);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error(`[scan] route: ERROR:`, err);
    if (acquired) endReview(prId);
    // Mark the run failed so the next scan doesn't 409 on an orphaned
    // in_progress row. reviewService handles failures inside runPrScan,
    // but this backstops throws between createReviewRun and runPrScan
    // (and any path where reviewService's own catch doesn't fire).
    if (reviewRunId) {
      try {
        await completeReviewRun(reviewRunId, { status: "failed" });
        console.log(`[scan] route: ReviewRun ${reviewRunId} marked failed`);
      } catch (runErr) {
        console.error(`[scan] route: failed to mark ReviewRun failed:`, runErr);
      }
    }
    try {
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'Failed' } });
      console.log(`[scan] route: PR status set to Failed`);
    } catch (dbErr) {
      console.error(`[scan] route: failed to mark PR as Failed:`, dbErr);
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
