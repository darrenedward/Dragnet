import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { refreshPrFiles, isBranchMerged } from "@/src/lib/getRealLocalPrs";
import { getChatChain } from "@/src/lib/llmClient";
import { acquireReviewLock, endReview } from "@/src/lib/reviewLocks";
import { computePrSizeProfile } from "@/src/lib/prSizeProfile";
import { readPrCommitCount } from "@/src/lib/prSizeProfile.server";
import { assertTier, buildDiffManifest, runLargePrReview } from "@/src/services/largePrReview";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  createReviewRun,
  completeReviewRun,
} from "@/src/lib/reviewFreshness";

export async function POST(req: Request) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error, passed: false }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { branch, repoPath, sha } = body;

  if (!branch || !repoPath) {
    return NextResponse.json(
      { error: "Missing required fields: branch, repoPath" },
      { status: 400 },
    );
  }

  // Hoisted so the catch can mark the run failed on throw — same fix as
  // scan/route.ts and prcheck/route.ts. Without this the run stays
  // in_progress and the next push 409s with SCAN_IN_PROGRESS.
  let reviewRunId: string | null = null;
  // Tracks whether THIS request acquired the in-memory lock so the catch
  // never releases a lock owned by a concurrent request.
  let acquiredLock = false;
  // Hoisted so the catch can call endReview() — `pr` is scoped inside try.
  let prIdForCleanup: string | null = null;
  try {
    const repo = await prisma.repository.findFirst({
      where: { path: repoPath },
    });
    if (!repo) {
      return NextResponse.json(
        { error: `Repository at "${repoPath}" is not registered in Dragnet. Add it from the Projects sidebar first.` },
        { status: 404 },
      );
    }

    const freshness = assertIndexFresh(repo);
    if (freshness.ok === false) {
      if (freshness.kind === "INDEX_REQUIRED") {
        return NextResponse.json(
          { passed: false, error: freshness.kind, message: freshness.message },
          { status: 409 },
        );
      }
      // STALE_INDEX — auto-trigger incremental index
      if (repo.path) {
        await IndexingService.indexFolder(repo.id, repo.path);
      }
    }

    const pr = await prisma.pullRequest.findFirst({
      where: { repoId: repo.id, sourceBranch: branch },
      orderBy: { createdAt: "desc" },
    });

    if (!pr) {
      return NextResponse.json(
        { error: `No Pull Request record found for branch "${branch}". Create one by opening Dragnet and selecting the repo.` },
        { status: 404 },
      );
    }
    prIdForCleanup = pr.id;

    // Refresh files from the actual git state on disk and create an
    // in_progress ReviewRun. The pre-push hook doesn't short-circuit on
    // cache hits — pushes should always run the gate, not trust a stale
    // review (the dev may have fixed the issue locally without re-scanning).
    const chatChain = getChatChain();
    let files: any[] = [];
    if (repo.path && pr.sourceBranch) {
      try {
        files = await refreshPrFiles(repo.path, repo.baseBranch || "main", pr.sourceBranch, pr.id);
      } catch (e) {
        console.warn("[prepush] refreshPrFiles failed, using cached PrFiles:", e);
      }
    }
    const baseBranch = pr.targetBranch || repo.baseBranch || "main";
    const sizeProfile = computePrSizeProfile(
      files,
      readPrCommitCount(repo.path, baseBranch, pr.sourceBranch),
    );
    const manifest = buildDiffManifest(files, sizeProfile.commitCount);
    const tier = assertTier(manifest);

    // Merged-branch short-circuit. Pre-push shouldn't fire for a merged
    // branch in normal flow (you don't push to a branch that's already
    // merged), but if it does, exit clean — no point gating an empty diff.
    if (repo.path && pr.sourceBranch && files.length === 0 && isBranchMerged(repo.path, baseBranch, pr.sourceBranch)) {
      return NextResponse.json({
        passed: true,
        merged: true,
        message: `Branch "${pr.sourceBranch}" is fully merged into "${repo.baseBranch || "main"}". Nothing to review.`,
        sizeProfile,
      });
    }
    const diffHash = computeDiffHash(files);
    const configHash = chatChain.length > 0
      ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION))
      : "";

    // Shared concurrency guard via reviewLocks helper — prepush has no
    // ?force flag (it's invoked by the git hook); the user can re-push
    // after the live scan finishes.
    const lock = await acquireReviewLock(pr.id, false);
    if (lock.status === "busy") {
      console.log(`[prepush] lock acquisition failed for ${pr.id} — 409 (runId=${lock.runId})`);
      return NextResponse.json(
        {
          passed: false,
          error: "SCAN_IN_PROGRESS",
          runId: lock.runId,
          startedAt: lock.startedAt,
          message: lock.message + " Re-push after it completes.",
        },
        { status: 409 },
      );
    }
    acquiredLock = true;

    reviewRunId = await createReviewRun({
      prId: pr.id,
      repoId: repo.id,
      commitHash: sha || pr.commitHash,
      diffHash,
      reviewConfigHash: configHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "prepush",
    });

    const result = tier.tier === "normal"
      ? await runPrScan(pr.id, files, reviewRunId)
      : await runLargePrReview({
          reviewRunId,
          prId: pr.id,
          files,
          tier: tier.tier,
          warning: "message" in tier ? tier.message : null,
        });

    // A null rating means the LLM chain couldn't produce a review (provider
    // outage / misconfig / model without tool-calling) — NOT a code-quality
    // failure. Surface the real reason via `error` (the pre-push hook prints
    // it and exits 1) instead of reporting a bogus "rating null/10" block.
    if (result.rating === null) {
      const reason = result.systemWarn || "LLM review unavailable — no rating produced.";
      return NextResponse.json({
        passed: false,
        rating: null,
        findingsCount: result.findings.length,
        findings: result.findings,
        error: `Review could not run — ${reason} (push not gated on code quality; fix LLM Settings or use --no-verify)`,
        systemWarn: result.systemWarn,
        usedModel: result.usedModel,
        sizeProfile,
        largePrMode: "largePrMode" in result ? result.largePrMode : false,
        reliability: "reliability" in result ? result.reliability : null,
      }, { status: 503 });
    }

    const reliability = "reliability" in result ? result.reliability : "complete";
    const passed = result.rating >= 8 && reliability === "complete";

    // Release the in-memory lock on the success path. Previously this was
    // only released in the catch block — every successful pre-push scan
    // leaked an entry in `activeReviews`, blocking re-reviews for 30 min
    // (REVIEW_TTL_MS) until TTL eviction. Bug surfaced when iter 6 ran
    // successfully and iter 7's prepush 409'd with "(in-memory)".
    if (acquiredLock && prIdForCleanup) endReview(prIdForCleanup);

    return NextResponse.json({
      passed,
      rating: result.rating,
      findingsCount: result.findings.length,
      findings: result.findings,
      message: passed
        ? `✓ Dragnet: PR approved (${result.rating}/10)`
        : reliability !== "complete"
          ? `✗ Dragnet: PR blocked — Large PR review is ${reliability}. Retry failed chunks or split the PR.`
          : `✗ Dragnet: PR blocked — rating ${result.rating}/10 (requires 8+). Fix findings or use --no-verify to bypass.`,
      usedModel: result.usedModel,
      sizeProfile,
      largePrMode: "largePrMode" in result ? result.largePrMode : false,
      reliability,
    });
  } catch (err: any) {
    console.error("Pre-push hook error:", err);
    if (acquiredLock && prIdForCleanup) endReview(prIdForCleanup);
    if (reviewRunId) {
      try {
        await completeReviewRun(reviewRunId, { status: "failed" });
      } catch (runErr) {
        console.error("Pre-push hook: failed to mark ReviewRun failed:", runErr);
      }
    }
    return NextResponse.json(
      { error: err.message, passed: false },
      { status: 500 },
    );
  }
}
