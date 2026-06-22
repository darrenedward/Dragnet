import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { runPrScan } from "@/reviewService";
import { authenticateMcpRequest } from "@/src/lib/mcpAuth";

export async function POST(req: Request) {
  const auth = await authenticateMcpRequest(req);
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

    const result = await runPrScan(pr.id);
    const passed = result.rating >= 9;

    return NextResponse.json({
      passed,
      rating: result.rating,
      findingsCount: result.findings.length,
      findings: result.findings,
      message: passed
        ? `✓ GrepLoop: PR approved (${result.rating}/10)`
        : `✗ GrepLoop: PR blocked — rating ${result.rating}/10 (requires 9+). Fix findings or use --no-verify to bypass.`,
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
