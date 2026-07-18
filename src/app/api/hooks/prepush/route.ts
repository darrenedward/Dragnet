import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateApiRequest } from "@/src/lib/apiAuth";
import { admitScanJobForPr, waitForScanJob } from "@/src/services/scanQueue";

/**
 * Pre-push keeps its synchronous pass/fail contract while delegating all
 * execution to the durable queue. The hook waits for the admitted job rather
 * than bypassing the global concurrency limit with a direct runner call.
 */
export async function POST(req: Request) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error, passed: false }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { branch, repoPath, sha } = body;
  if (!branch || !repoPath) {
    return NextResponse.json({ error: "Missing required fields: branch, repoPath", passed: false }, { status: 400 });
  }

  const repo = await prisma.repository.findFirst({ where: { path: repoPath } });
  if (!repo) {
    return NextResponse.json({
      error: `Repository at "${repoPath}" is not registered in Dragnet. Add it from the Projects sidebar first.`,
      passed: false,
    }, { status: 404 });
  }
  const pr = await prisma.pullRequest.findFirst({
    where: { repoId: repo.id, sourceBranch: branch },
    orderBy: { createdAt: "desc" },
    select: { id: true, commitHash: true },
  });
  if (!pr) {
    return NextResponse.json({ error: `No Pull Request record found for branch "${branch}".`, passed: false }, { status: 404 });
  }

  // The hook knows the commit being pushed even when the local PR mirror has
  // not observed it yet. Keep the queue's coalescing key and worker revision
  // guard aligned with that commit.
  if (typeof sha === "string" && sha && sha !== pr.commitHash) {
    await prisma.pullRequest.update({ where: { id: pr.id }, data: { commitHash: sha } });
  }

  const job = await admitScanJobForPr({
    prId: pr.id,
    triggerReason: "prepush",
    createdByUserId: auth.userId,
  });
  if (!job) return NextResponse.json({ error: "Pull request disappeared before scan admission.", passed: false }, { status: 404 });

  const terminal = await waitForScanJob(job.jobId);
  if (!terminal) {
    return NextResponse.json({
      passed: false,
      accepted: true,
      jobId: job.jobId,
      error: "Review is still queued or running; push was not approved.",
    }, { status: 202 });
  }
  if (terminal.state !== "completed" || !terminal.reviewRunId) {
    return NextResponse.json({ passed: false, jobId: job.jobId, error: terminal.errorMessage || `Review ${terminal.state}.` }, { status: 503 });
  }

  const run = await prisma.reviewRun.findUnique({
    where: { id: terminal.reviewRunId },
    select: { rating: true, reliability: true, model: true },
  });
  const findings = await prisma.reviewFinding.findMany({
    where: { reviewRunId: terminal.reviewRunId },
    orderBy: { timestamp: "asc" },
  });
  const rating = run?.rating ?? null;
  const reliability = run?.reliability ?? "complete";
  const passed = rating !== null && rating >= 8 && reliability === "complete";
  return NextResponse.json({
    passed,
    rating,
    findingsCount: findings.length,
    findings,
    usedModel: run?.model ?? null,
    reliability,
    jobId: job.jobId,
    message: passed
      ? `✓ Dragnet: PR approved (${rating}/10)`
      : `✗ Dragnet: PR blocked — rating ${rating ?? "unavailable"}/10 (requires 8+).`,
  });
}
