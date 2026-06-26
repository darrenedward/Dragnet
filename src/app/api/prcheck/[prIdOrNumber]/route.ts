import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { findPrByIdOrNumber } from "@/src/lib/findPr";
import { runPrScan, SYSTEM_INSTRUCTION } from "@/reviewService";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { IndexingService } from "@/src/services/indexingService";
import { assertIndexFresh } from "@/src/lib/indexFreshness";
import { refreshPrFiles } from "@/src/lib/getRealLocalPrs";
import { getChatChain } from "@/src/lib/llmClient";
import {
  computeDiffHash,
  computeReviewConfigHash,
  shortHash,
  assertNoActiveScan,
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

    const repo = await prisma.repository.findUnique({
      where: { id: pr.repoId },
      select: { id: true, name: true, indexedAt: true, lastCommitHash: true, path: true, baseBranch: true },
    });
    if (!repo) {
      return NextResponse.json({
        status: "Error",
        message: `Repository for PR "${prIdOrNumber}" could not be loaded.`,
      }, { status: 404 });
    }

    const freshness = assertIndexFresh(repo);
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
    if (repo.path && pr.sourceBranch) {
      try {
        files = await refreshPrFiles(repo.path, repo.baseBranch || "main", pr.sourceBranch, pr.id);
      } catch (e) {
        console.warn("[prcheck] refreshPrFiles failed, using cached:", e);
      }
    }
    const diffHash = computeDiffHash(files);
    const configHash = chatChain.length > 0
      ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION))
      : "";

    const force = url.searchParams.get("force") === "true";
    const activeScan = await assertNoActiveScan(pr.id, force);
    if (activeScan.ok === false) {
      console.log(`[prcheck] scan ${activeScan.runId} already in progress for ${pr.id} — 409`);
      return NextResponse.json({
        status: "Error",
        error: "SCAN_IN_PROGRESS",
        runId: activeScan.runId,
        startedAt: activeScan.startedAt,
        message: `A scan is already running for this PR (started ${activeScan.startedAt.toISOString()}). Use ?force=true to override.`,
      }, { status: 409 });
    }

    reviewRunId = await createReviewRun({
      prId: pr.id,
      repoId: pr.repoId,
      commitHash: pr.commitHash,
      diffHash,
      reviewConfigHash: configHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "prcheck",
    });

    const scanResult = await runPrScan(pr.id, files, reviewRunId);
    const isProductionReady = scanResult.rating !== null && scanResult.rating >= 8;

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
  }
}
