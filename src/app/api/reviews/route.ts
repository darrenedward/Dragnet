import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { authenticateSessionOrKey } from "@/src/lib/apiAuth";

export async function GET(req: Request) {
  // Route-level auth: review history is private to the operator. proxy.ts
  // only checks cookie PRESENCE — validate the session against the DB.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const reviews = await prisma.reviewHistory.findMany({
      orderBy: { timestamp: 'desc' },
      take: 20
    });
    return NextResponse.json(reviews);
  } catch (err: any) {
    console.error("Error loading reviews history:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // Route-level auth: same reason as GET — review logging is operator-only.
  const auth = await authenticateSessionOrKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await req.json();
    const { id, repoId, repoName, branch, commitHash, triggerReason, status } = body;
    const requiredFields = ["repoId", "repoName", "branch", "commitHash", "triggerReason"] as const;
    for (const field of requiredFields) {
      if (!body[field] || typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} is required.` }, { status: 400 });
      }
    }
    const keyId = id || `rev-${Date.now()}`;

    await prisma.reviewHistory.create({
      data: {
        id: keyId,
        repoId,
        repoName,
        branch,
        commitHash,
        triggerReason,
        status: status || 'done',
        timestamp: new Date().toISOString()
      }
    });

    await prisma.repository.updateMany({
      where: { id: repoId },
      data: { reviewsCount: { increment: 1 } }
    });

    if (branch) {
      const prId = `real-pr-${repoId}-${branch.replace(/\//g, "-")}`;
      await prisma.pullRequest.updateMany({
        where: { id: prId },
        data: { status: 'Completed' }
      });
      // Manual review logging — do NOT seed templated findings. Previous
      // behavior (procedural fallback) fabricated CORS-style hallucinations
      // that looked like real LLM output. Now we leave the findings list
      // empty; if the user wants real findings they can trigger a scan via
      // /dragnet or the dashboard, which uses the live LLM chain.
    }

    return NextResponse.json({ success: true, id: keyId }, { status: 201 });
  } catch (err: any) {
    console.error("Error logging manual review action:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
