import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
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
  createReviewRun,
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

  try {
    const repo = await prisma.repository.findFirst({
      where: { path: repoPath },
    });
    if (!repo) {
      return NextResponse.json(
        { error: `Repository at "${repoPath}" is not registered in GrepLoop. Add it from the Projects sidebar first.` },
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
        { error: `No Pull Request record found for branch "${branch}". Create one by opening GrepLoop and selecting the repo.` },
        { status: 404 },
      );
    }

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
    const diffHash = computeDiffHash(files);
    const configHash = chatChain.length > 0
      ? computeReviewConfigHash(chatChain, shortHash(SYSTEM_INSTRUCTION))
      : "";

    const reviewRunId = await createReviewRun({
      prId: pr.id,
      repoId: repo.id,
      commitHash: sha || pr.commitHash,
      diffHash,
      reviewConfigHash: configHash,
      model: chatChain[0]?.model ?? null,
      triggerReason: "prepush",
    });

    const result = await runPrScan(pr.id, files, reviewRunId);

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
      }, { status: 503 });
    }

    const passed = result.rating >= 8;

    return NextResponse.json({
      passed,
      rating: result.rating,
      findingsCount: result.findings.length,
      findings: result.findings,
      message: passed
        ? `✓ GrepLoop: PR approved (${result.rating}/10)`
        : `✗ GrepLoop: PR blocked — rating ${result.rating}/10 (requires 8+). Fix findings or use --no-verify to bypass.`,
      usedModel: result.usedModel,
    });
  } catch (err: any) {
    console.error("Pre-push hook error:", err);
    return NextResponse.json(
      { error: err.message, passed: false },
      { status: 500 },
    );
  }
}
