import { NextResponse } from "next/server";
import { authenticateScanToken } from "@/src/services/hostedScan/scanToken";
import { triggerHostedScan } from "@/src/services/hostedScan/orchestrator";
import type { HostedPrData } from "@/src/services/hostedScan/orchestrator";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing scan token. Use: Authorization: Bearer hs_<token>" }, { status: 401 });
  }

  const raw = auth.slice("Bearer ".length).trim();
  const tokenAuth = await authenticateScanToken(raw);
  if (!tokenAuth.ok) {
    return NextResponse.json({ error: (tokenAuth as { error: string }).error }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.prNumber || !body.title || !body.headBranch || !body.baseBranch || !body.commitHash) {
    return NextResponse.json({
      error: "Missing required fields: prNumber, title, headBranch, baseBranch, commitHash",
    }, { status: 400 });
  }

  const prData: HostedPrData = {
    prNumber: body.prNumber,
    title: body.title,
    headBranch: body.headBranch,
    baseBranch: body.baseBranch,
    commitHash: body.commitHash,
    author: body.author ?? "hosted",
    description: body.description ?? undefined,
  };

  const result = await triggerHostedScan(tokenAuth.repoId, prData);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true, prId: result.prId, runId: result.runId });
}
