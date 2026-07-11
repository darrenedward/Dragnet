import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { refreshPrFiles, isBranchMerged } from "@/src/lib/getRealPrs";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { IndexingService } from "@/src/services/indexingService";
import { getChatChain, getEmbeddingChain } from "@/src/lib/llmClient";
import { acquireReviewLock, endReview, checkPendingAbort } from "@/src/lib/reviewLocks";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";
import { assertTier, buildDiffManifest, runLargePrReview } from "@/src/services/largePrReview";
import { readLimits } from "@/src/lib/prSizeConfig";
import { authenticateSessionOrKey, enforcePrRepoScope } from "@/src/lib/apiAuth";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  assertReviewFreshness,
  createReviewRun,
  completeReviewRun,
} from "@/src/lib/reviewFreshness";
import {
  readCheckpoint,
  deleteRunCheckpoints,
  RUN_CHECKPOINT_ID,
  type CheckpointState,
} from "@/src/services/checkpointStore";
import { logReview } from "@/src/services/deterministicChecks/logging";

export async function POST(req: Request, { params }: { params: Promise<{ prId: string }> }) {
  // Route-level auth: this is the UI scan trigger (the API-key path is
  // /api/command via the /dragnet skill). proxy.ts is cookie-PRESENCE only.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const { prId } = await params;
  const prScopeErr = await enforcePrRepoScope(auth, prId);
  if (prScopeErr) return NextResponse.json(prScopeErr, { status: 403 });
  await req.json().catch(() => ({}));
  console.log(`[scan] route: POST received for prId=${prId}`);
  const force = new URL(req.url).searchParams.get("force") === "true";
  void logReview(prId, `> Scan requested via /api/prs/.../scan (force=${force})`, "info");
  // Phase 7 resume parameters. `resume=true` loads the prior run's
  // checkpoint and continues at the saved iteration. `fresh=true` marks
  // the prior run failed/interrupted, deletes its checkpoints, and
  // starts a brand new scan. Both are mutually exclusive with each
  // other and with plain `force=true` (which is the legacy "abort and
  // restart" semantics — no checkpoint inspection).
  const resume = new URL(req.url).searchParams.get("resume") === "true";
  const fresh = new URL(req.url).searchParams.get("fresh") === "true";

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
      select: {
        id: true,
        name: true,
        indexedAt: true,
        lastCommitHash: true,
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
      },
    });
    if (!repo) {
      console.log(`[scan] route: repo not found for repoId=${pr.repoId}`);
      return NextResponse.json({ error: "Repository record not found." }, { status: 404 });
    }
    console.log(`[scan] route: repo=${repo.name}, indexedAt=${repo.indexedAt}, path=${repo.path}`);

    const freshness = await assertIndexFresh(repo);
    if (freshness.ok === false) {
      console.log(`[scan] route: freshness not ok kind=${freshness.kind} message=${freshness.message}`);
      if (freshness.kind === "INDEX_REQUIRED") {
        const indexingInProgress = IndexingService.isIndexing(pr.repoId);
        if (indexingInProgress) {
          console.log(`[scan] route: INDEX_REQUIRED but indexing is in progress — returning 409`);
          return NextResponse.json(
            { error: "INDEXING_IN_PROGRESS", message: "Indexing is currently running for this repo. Please wait for it to complete before running a PR review.", repoId: pr.repoId },
            { status: 409 },
          );
        }
        console.log(`[scan] route: INDEX_REQUIRED - returning 409`);
        return NextResponse.json(
          { error: freshness.kind, message: freshness.message, repoId: pr.repoId },
          { status: 409 },
        );
      }
      console.log(`[scan] route: STALE_INDEX - triggering incremental index`);
    void logReview(prId, `> Index is stale — running incremental reindex inline…`, "info");
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
    if ((repo.path || repo.cloneUrl) && pr.sourceBranch) {
      console.log(`[scan] route: refreshing PR files from git`);
      files = await refreshPrFiles(repo, pr.sourceBranch, prId);
      console.log(`[scan] route: got ${files.length} files`);
    void logReview(prId, `> Diff files refreshed — ${files.length} file${files.length === 1 ? "" : "s"} in scope`, "info");

      // Check if Stop was clicked during the (potentially slow) file
      // collection phase. When no review lock exists yet, abortScan
      // stores the prId in pendingAborts — check it here and bail.
      if (checkPendingAbort(prId)) {
        console.log(`[scan] route: abort requested during file collection — returning interrupted`);
        return NextResponse.json({
          success: false,
          interrupted: true,
          rating: null,
          findings: [],
          usedModel: null,
          systemWarn: null,
          message: "Scan cancelled during file collection.",
        });
      }
    } else {
      console.log(`[scan] route: no repoPath or sourceBranch - skipping file refresh`);
    }
    const sizeProfile = computePrSizeProfile(
      files,
      await readPrCommitCount(repo, baseBranch, pr.sourceBranch),
    );
    const limits = readLimits();
    const manifest = buildDiffManifest(files, sizeProfile.commitCount, {
      normalMaxLines: limits.normalMaxLines,
      normalMaxCodeFiles: limits.normalMaxCodeFiles,
      oversizedLines: limits.oversizedLines,
      oversizedCodeFiles: limits.oversizedCodeFiles,
    });
    const tier = assertTier(manifest);
    const tierLines = "codeLines" in manifest && typeof manifest.codeLines === "number" ? manifest.codeLines.toLocaleString() + " code lines" : "n/a";
    void logReview(
      prId,
      `> Tier detected: ${tier.tier} (${tierLines})`,
      "info",
    );

    // Merged-branch short-circuit. If the branch is fully merged into base,
    // there is nothing to review — returning a clean merged state instead
    // of letting runPrScan throw "No modified files". Also marks the PR
    // row so the list view can render it as Merged.
    if ((repo.path || repo.cloneUrl) && pr.sourceBranch && files.length === 0 && await isBranchMerged(repo, baseBranch, pr.sourceBranch)) {
      console.log(`[scan] route: branch ${pr.sourceBranch} fully merged into ${baseBranch} — returning merged state`);
      await prisma.pullRequest.update({
        where: { id: prId },
        data: { status: "Merged" },
      }).catch((e: unknown) => console.warn(`[scan] route: failed to mark PR Merged:`, e));
      return NextResponse.json({
        merged: true,
        message: `Branch "${pr.sourceBranch}" is fully merged into "${baseBranch}". Nothing to review.`,
        rating: null,
        findings: [],
        sizeProfile,
      });
    }

    // Review freshness guard. If a completed ReviewRun exists for the same
    // (commitHash, diffHash, reviewConfigHash), short-circuit and return the
    // cached findings. `force=true` bypasses.
    const currentDiffHash = computeDiffHash(files, pr.commitHash);
    const currentConfigHash = computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION), limits);
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
          select: { id: true, category: true, severity: true, exploitability: true, impact: true, filename: true, line: true, explanation: true, diffSuggestion: true, evidenceChain: true, confidence: true, verificationStatus: true, verificationNote: true, timestamp: true },
        });
        return NextResponse.json({
          cached: true,
          runId: fresh.runId,
          rating: fresh.rating,
          findings,
          usedModel: null,
          sizeProfile,
        });
      }
      // fresh.ok === false → narrowed to STALE_RUN / NO_RUN
      console.log(`[scan] route: cache MISS — running scan`);
      void logReview(prId, `> Cache miss — kicking off fresh ${tier.tier} scan`, "info");
    }

    // Concurrency guard — shared with the command/prcheck/prepush routes.
    // The in-memory isReviewActive check catches same-process races; the
    // DB-backed assertNoActiveScan catches cross-process races (another
    // worker, or a scan started via the /dragnet skill while a UI scan runs).
    // Concurrency guard via shared helper — wraps in-memory lock +
    // DB-backed assertNoActiveScan + beginReview in one call. The other
    // three scan entry points (prcheck, prepush, command) use the same
    // helper so they all share identical guard semantics.
    //
    // Phase 7: pass repoPath so assertNoActiveScan can inspect stale runs
    // for recoverable checkpoint state. Resume and Start fresh both act
    // like force=true at the lock layer (they replace the stale run) —
    // the route layer decides whether to load the checkpoint (resume) or
    // delete it (fresh) before calling runPrScan.
    const lock = await acquireReviewLock(prId, force || resume || fresh, repo.path);
    if (lock.status === "busy") {
      console.log(`[scan] route: lock acquisition failed for ${prId} — 409 (runId=${lock.runId})`);
      return NextResponse.json(
        {
          error: "SCAN_IN_PROGRESS",
          runId: lock.runId,
          startedAt: lock.startedAt,
          message: lock.message + (force ? "" : " Use ?force=true to override."),
        },
        { status: 409 },
      );
    }
    // Phase 7 — stale_inspectable: a stale in_progress run has a valid
    // checkpoint. Don't acquire the lock; surface the resume info so the
    // UI can prompt the user to Continue or Start fresh. The stale run
    // row stays in_progress; the next call with ?resume=true or ?fresh=true
    // will replace it (both pass force=true at the lock layer).
    if (lock.status === "stale_inspectable") {
      console.log(`[scan] route: stale run ${lock.runId} has checkpoint ${lock.checkpointId} — surfacing resume affordance`);
      // Validate hashes BEFORE advertising resume — if code or config
      // already moved, the checkpoint is useless and the caller should
      // just start fresh. This is the same gate the resume path enforces,
      // but running it here lets the UI render the right CTA.
      const codeChanged = lock.commitHash !== pr.commitHash || lock.diffHash !== currentDiffHash;
      const configChanged = lock.reviewConfigHash !== currentConfigHash;
      return NextResponse.json({
        status: "interrupted",
        runId: lock.runId,
        checkpointId: lock.checkpointId,
        completedIterations: lock.completedIterations,
        totalIterations: lock.totalIterations,
        reachedPercent: lock.totalIterations > 0
          ? Math.round((lock.completedIterations / lock.totalIterations) * 100)
          : 0,
        lastProvider: lock.lastProvider,
        lastModel: lock.lastModel,
        startedAt: lock.startedAt,
        resumeAllowed: !codeChanged && !configChanged,
        codeChanged,
        configChanged,
        message: codeChanged
          ? "Cannot resume — the PR's code has changed since the checkpoint."
          : configChanged
            ? "Cannot resume — the review configuration (model, prompt, or limits) has changed since the checkpoint."
            : "Scan was interrupted. Continue from iteration " +
              `${lock.completedIterations + 1}/${lock.totalIterations} or start fresh.`,
      });
    }
    acquired = true;
    const releaseLock = lock.release;
    // Phase 4: signal lets force-restart abort the in-flight scan at the
    // SDK layer. Threaded into runPrScan / runLargePrReview so every
    // chat.completions.create call receives it as a request option.
    const scanSignal = lock.signal;

    // Phase 7 resume — load the checkpoint from the prior stale run.
    // AcquireReviewLock with force=true already cleared the in-memory
    // lock and aborted the prior scan's controller; the prior run row
    // is still in_progress in the DB. We re-use that row's id instead
    // of creating a new one so resume telemetry, lastCheckpointAt, etc.
    // attach to the same run the user is resuming.
    let resumeRunId: string | null = null;
    let resumeSeed: { messages: CheckpointState["messages"]; loopCount: number } | null = null;
    if (resume || fresh) {
      const staleRun = await prisma.reviewRun.findFirst({
        where: { prId, status: "in_progress" },
        orderBy: { startedAt: "desc" },
        select: { id: true, commitHash: true, diffHash: true, reviewConfigHash: true },
      });
      if (staleRun) {
        if (fresh) {
          // Delete checkpoints and mark the old run interrupted — clean
          // slate for the new scan.
          if (repo.path) {
            try {
              deleteRunCheckpoints(repo.path, staleRun.id);
            } catch (err: any) {
              console.warn(`[scan] route: failed to delete checkpoints for ${staleRun.id}: ${err?.message ?? err}`);
            }
          }
          try {
            await prisma.reviewRun.update({
              where: { id: staleRun.id },
              data: {
                status: "failed",
                completedAt: new Date(),
              },
            });
            console.log(`[scan] route: Start fresh — marked prior run ${staleRun.id} failed`);
          } catch (err: any) {
            console.warn(`[scan] route: failed to mark prior run ${staleRun.id} failed: ${err?.message ?? err}`);
          }
        } else {
          // Resume path — validate hashes before loading.
          const codeChanged = staleRun.commitHash !== pr.commitHash
            || staleRun.diffHash !== currentDiffHash;
          const configChanged = staleRun.reviewConfigHash !== currentConfigHash;
          if (codeChanged || configChanged) {
            return NextResponse.json(
              {
                error: codeChanged ? "RESUME_REJECTED_CODE_CHANGED" : "RESUME_REJECTED_CONFIG_CHANGED",
                message: codeChanged
                  ? "Cannot resume — the PR's code has changed since the checkpoint."
                  : "Cannot resume — the review configuration has changed since the checkpoint.",
              },
              { status: 409 },
            );
          }
          if (repo.path) {
            const cp = readCheckpoint(repo.path, staleRun.id, RUN_CHECKPOINT_ID);
            if (cp) {
              resumeRunId = staleRun.id;
              resumeSeed = { messages: cp.messages, loopCount: cp.loopCount };
              console.log(`[scan] route: resuming run ${staleRun.id} from iteration ${cp.loopCount + 1}`);
            } else {
              console.log(`[scan] route: resume requested but no __run checkpoint found for ${staleRun.id} — starting fresh`);
            }
          }
        }
      }
    }

    await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
    console.log(`[scan] route: status set to In Progress`);

    // Phase 7 resume — re-use the prior run id instead of creating a new
    // row when the user chose Continue. This keeps the run's telemetry,
    // checkpoints, and reviewLogs coherent across the interruption.
    reviewRunId = resumeRunId ?? await createReviewRun({
      prId,
      repoId: pr.repoId,
      commitHash: pr.commitHash,
      diffHash: currentDiffHash,
      reviewConfigHash: currentConfigHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "manual",
      forced: force,
      createdByUserId: auth.userId,
    });
    if (resumeRunId) {
      // Resume re-uses the prior run row — flip it back to in_progress
      // so isRunStillActive / assertReviewRunStillActive let the loop run.
      try {
        await prisma.reviewRun.update({
          where: { id: resumeRunId },
          data: { status: "in_progress", completedAt: null },
        });
      } catch (err: any) {
        console.warn(`[scan] route: failed to reset run ${resumeRunId} to in_progress: ${err?.message ?? err}`);
      }
    }
    console.log(`[scan] route: ${resumeRunId ? `resuming` : `created in_progress`} ReviewRun ${reviewRunId}`);

    console.log(`[scan] route: calling ${tier.tier === "normal" ? "runPrScan" : "runLargePrReview"} with ${files.length} files`);
    // Phase 5 resume — pass the hash trio so every iteration checkpoint
    // carries the gates resume will validate against.
    const checkpointMetadata = {
      commitHash: pr.commitHash,
      diffHash: currentDiffHash,
      reviewConfigHash: currentConfigHash,
    };
    const result = tier.tier === "normal"
      ? await runPrScan(prId, files, reviewRunId, undefined, undefined, {
          signal: scanSignal,
          checkpointMetadata,
          ...(resumeSeed ? { initialMessages: resumeSeed.messages, startLoopCount: resumeSeed.loopCount } : {}),
        })
      : await runLargePrReview({
          reviewRunId,
          prId,
          files,
          tier: tier.tier,
          warning: "message" in tier ? tier.message : null,
          signal: scanSignal,
          checkpointMetadata,
        });
    console.log(`[scan] route: runPrScan complete - rating=${result.rating}, findings=${result.findings?.length}, model=${result.usedModel}, interrupted=${result.interrupted ?? false}`);

    if (acquired) endReview(prId);
    // Phase 4: typed interruption is a non-terminal state — NOT success,
    // NOT failure. Return interrupted JSON without marking the run row
    // completed or failed. Phase 5 will surface a resume affordance and
    // persist `lastCheckpointAt`.
    if (result.interrupted) {
      return NextResponse.json({
        ...result,
        sizeProfile,
        interrupted: true,
      });
    }
    // Sync the PR's `status` column with what runPrScan just produced.
    // The optimistic 'In Progress' was set when the lock was acquired;
    // for any terminal outcome (full-review success, trivial-skip, or
    // quality-failure with findings) the sidebar needs to flip back so
    // the user sees the real state instead of "In Progress" until the
    // 15s poller overwrites it. `Failed` is handled in the catch block
    // below; we only handle the non-failure terminal cases here.
    try {
      await prisma.pullRequest.updateMany({
        where: { id: prId },
        data: { status: "Completed" },
      });
    } catch (statusErr) {
      console.warn(`[scan] route: failed to clear PR In Progress status:`, statusErr);
    }
    // Popup data-source: most recent prior NON-SKIPPED completed run for
    // this PR. Used by TrivialSkipNotice to honestly show "your last code
    // grade was X/10 from Y" when the current scan trivial-skipped. Null
    // when no prior code-touching review exists. Excludes the just-finished
    // run (reviewRunId) so a fresh scan doesn't return itself as "prior".
    let priorReviewRun: { rating: number | null; completedAt: string | null } | null = null;
    try {
      const prior = await prisma.reviewRun.findFirst({
        where: {
          prId,
          status: "completed",
          id: reviewRunId ? { not: reviewRunId } : undefined,
          outcome: { not: "skipped" },
        },
        orderBy: { completedAt: "desc" },
        select: { rating: true, completedAt: true },
      });
      if (prior) {
        priorReviewRun = {
          rating: prior.rating,
          completedAt: prior.completedAt ? prior.completedAt.toISOString() : null,
        };
      }
    } catch (priorErr) {
      console.warn(`[scan] route: failed to load priorReviewRun for prId=${prId}:`, priorErr);
    }
    return NextResponse.json({ ...result, sizeProfile, priorReviewRun });
  } catch (err: any) {
    console.error(`[scan] route: ERROR:`, err);
    if (acquired) endReview(prId);
    // Phase 4: an AbortError that escapes runPrScan (e.g. from
    // refreshPrFiles or pre-scan DB calls) is still a typed interruption,
    // not a 500. Detect by error name and return the same interrupted
    // shape. We do NOT mark the run failed — Phase 5 owns the
    // interrupted-status persistence.
    if (err?.name === "AbortError") {
      console.log(`[scan] route: AbortError escaped runner — returning interrupted JSON`);
      return NextResponse.json({
        success: false,
        interrupted: true,
        rating: null,
        findings: [],
        usedModel: "unconfigured",
        systemWarn: null,
        message: "Scan aborted (force-restart or cancellation).",
      });
    }
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
