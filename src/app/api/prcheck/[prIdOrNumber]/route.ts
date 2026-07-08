import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { refreshPrFiles, isBranchMerged } from "@/src/lib/getRealPrs";
import { getChatChain } from "@/src/lib/llmClient";
import { acquireReviewLock, endReview } from "@/src/lib/reviewLocks";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";
import { assertTier, buildDiffManifest, runLargePrReview } from "@/src/services/largePrReview";
import { readLimits } from "@/src/lib/prSizeConfig";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  createReviewRun,
  completeReviewRun,
} from "@/src/lib/reviewFreshness";

export async function GET(req: Request, { params }: { params: Promise<{ prIdOrNumber: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ status: "Error", message: auth.error }, { status: 401 });
  }

  const { prIdOrNumber } = await params;
  // Hoisted so the catch can mark the run failed if runPrScan (or anything
  // between createReviewRun and the return) throws. Without this, the run
  // stays in_progress and the next call 409s with SCAN_IN_PROGRESS.
  let reviewRunId: string | null = null;
  // Tracks whether THIS request acquired the in-memory lock, so a failure
  // before acquisition never clears a concurrent scan's lock.
  let acquired = false;
  // Hoisted so the catch can call endReview() — `pr` is scoped inside try.
  let prIdForCleanup: string | null = null;
  try {
    const url = new URL(req.url);
    const repoId = url.searchParams.get("repoId") || undefined;
    const pr = await findPrByIdOrNumber(prIdOrNumber, repoId);
    if (!pr) {
      return NextResponse.json({
        status: "Error",
        message: `Pull request reference "${prIdOrNumber}" could not be matched in the database.`
      }, { status: 404 });
    }
    prIdForCleanup = pr.id;

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
      return NextResponse.json({
        status: "Error",
        message: `Repository for PR "${prIdOrNumber}" could not be loaded.`,
      }, { status: 404 });
    }

    const freshness = await assertIndexFresh(repo);
    if (freshness.ok === false) {
      if (freshness.kind === "INDEX_REQUIRED") {
        return NextResponse.json({ status: "Error", message: freshness.message }, { status: 409 });
      }
      // STALE_INDEX — auto-trigger incremental index
      if (repo.path) {
        await IndexingService.indexFolder(pr.repoId, repo.path);
      }
    }

    // Refresh files + create in_progress ReviewRun so the run is tracked.
    // prcheck is an explicit CLI invocation — always runs the scan (no
    // short-circuit), unlike the dashboard route.
    const chatChain = getChatChain();
    let files: any[] = [];
    if ((repo.path || repo.cloneUrl) && pr.sourceBranch) {
      try {
        files = await refreshPrFiles(repo, pr.sourceBranch, pr.id);
      } catch (e) {
        console.warn("[prcheck] refreshPrFiles failed, using cached:", e);
      }
    }
    const baseBranch = pr.targetBranch || repo.baseBranch || "main";
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

    // Merged-branch short-circuit — same rationale as scan/route.ts.
    if ((repo.path || repo.cloneUrl) && pr.sourceBranch && files.length === 0 && await isBranchMerged(repo, baseBranch, pr.sourceBranch)) {
      await prisma.pullRequest.update({
        where: { id: pr.id },
        data: { status: "Merged" },
      }).catch((e: unknown) => console.warn("[prcheck] failed to mark PR Merged:", e));
      return NextResponse.json({
        status: "Merged",
        prId: pr.id,
        title: pr.title,
        productionGrade: "N/A",
        rating: "—",
        assessment: `Branch "${pr.sourceBranch}" is fully merged into "${repo.baseBranch || "main"}". Nothing to review.`,
        findingsCount: 0,
        findings: [],
        sizeProfile,
      });
    }
    const diffHash = computeDiffHash(files);
    const configHash = chatChain.length > 0
      ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION), limits)
      : "";

    const force = url.searchParams.get("force") === "true";
    // Shared concurrency guard — same helper as scan/route.ts so a UI
    // scan and a CLI prcheck on the same PR can't race.
    const lock = await acquireReviewLock(pr.id, force);
    if (lock.status === "busy") {
      console.log(`[prcheck] lock acquisition failed for ${pr.id} — 409 (runId=${lock.runId})`);
      return NextResponse.json({
        status: "Error",
        error: "SCAN_IN_PROGRESS",
        runId: lock.runId,
        startedAt: lock.startedAt,
        message: lock.message + (force ? "" : " Use ?force=true to override."),
      }, { status: 409 });
    }
    acquired = true;

    reviewRunId = await createReviewRun({
      prId: pr.id,
      repoId: pr.repoId,
      commitHash: pr.commitHash,
      diffHash,
      reviewConfigHash: configHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "prcheck",
      createdByUserId: auth.userId,
    });

    const scanResult = tier.tier === "normal"
      ? await runPrScan(pr.id, files, reviewRunId)
      : await runLargePrReview({
          reviewRunId,
          prId: pr.id,
          files,
          tier: tier.tier,
          warning: "message" in tier ? tier.message : null,
        });
    const reliability = "reliability" in scanResult ? scanResult.reliability : "complete";
    const isProductionReady = scanResult.rating !== null && scanResult.rating >= 8 && reliability === "complete";

    return NextResponse.json({
      status: "Success",
      prId: pr.id,
      title: pr.title,
      productionGrade: isProductionReady ? "YES" : "NO",
      rating: scanResult.rating !== null ? `${scanResult.rating}/10` : "—",
      assessment: isProductionReady
        ? "This Pull Request is highly secure, performant, correct, and fully production grade."
        : "NOT production grade. Please review the blocker/warning findings in comments and refactor.",
      usedModel: scanResult.usedModel,
      findingsCount: scanResult.findings.length,
      sizeProfile,
      largePrMode: "largePrMode" in scanResult ? scanResult.largePrMode : false,
      reliability,
      chunksTotal: "chunksTotal" in scanResult ? scanResult.chunksTotal : 0,
      chunksCompleted: "chunksCompleted" in scanResult ? scanResult.chunksCompleted : 0,
      chunksFailed: "chunksFailed" in scanResult ? scanResult.chunksFailed : 0,
      chunksSkipped: "chunksSkipped" in scanResult ? scanResult.chunksSkipped : 0,
      findings: scanResult.findings.map((f: any) => ({
        category: f.category,
        severity: f.severity,
        filename: f.filename,
        line: f.line,
        explanation: f.explanation,
        diffSuggestion: f.diffSuggestion,
        evidenceChain: f.evidenceChain || []
      })),
      systemWarn: scanResult.systemWarn
    });
  } catch (err: any) {
    console.error("[prcheck error]:", err);
    if (reviewRunId) {
      try {
        await completeReviewRun(reviewRunId, { status: "failed" });
      } catch (runErr) {
        console.error("[prcheck error]: failed to mark ReviewRun failed:", runErr);
      }
    }
    return NextResponse.json({ status: "Error", message: err.message }, { status: 500 });
  } finally {
    // Release on BOTH success and error paths — the success return above
    // used to skip endReview, leaving the in-memory lock held until the
    // 5-min TTL evicted it (blocked re-reviews / force=false scans).
    if (acquired && prIdForCleanup) endReview(prIdForCleanup);
  }
}
