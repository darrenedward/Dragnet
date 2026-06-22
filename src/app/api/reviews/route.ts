import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { generateRealisticFindings } from "@/reviewService";

export async function GET() {
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

      const pr = await prisma.pullRequest.findUnique({ where: { id: prId } });
      if (pr) {
        const files = await prisma.prFile.findMany({
          where: { prId },
          select: { filename: true, diff: true, modifiedContent: true }
        });
        if (files.length > 0) {
          const existingCount = await prisma.reviewFinding.count({ where: { prId } });
          if (existingCount === 0) {
            const findings = generateRealisticFindings(pr, files);
            let index = 1;
            for (const finding of findings) {
              await prisma.reviewFinding.create({
                data: {
                  id: `find-live-${prId}-${index++}`,
                  prId,
                  repoId,
                  category: finding.category || "Style",
                  severity: finding.severity || "suggestion",
                  filename: finding.filename || files[0].filename,
                  line: finding.line || 1,
                  explanation: finding.explanation || "No explanation provided.",
                  diffSuggestion: finding.diffSuggestion || null,
                  timestamp: new Date().toISOString()
                }
              });
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true, id: keyId }, { status: 201 });
  } catch (err: any) {
    console.error("Error logging manual review action:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
