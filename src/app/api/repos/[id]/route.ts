import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const repo = await prisma.repository.findUnique({ where: { id } });
    if (!repo) {
      return NextResponse.json({ error: "Repository record not found" }, { status: 404 });
    }
    return NextResponse.json(repo);
  } catch (err: any) {
    console.error("Error fetching repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const {
      activeBranch,
      status,
      lastCommitHash,
      lastCommitMessage,
      stabilizationTimer,
      reviewsCount,
      triggerMode,
      quietPeriodSeconds,
      branchPattern,
      path: repoPath
    } = body;

    const current = await prisma.repository.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Repository record not found" }, { status: 404 });
    }

    await prisma.repository.update({
      where: { id },
      data: {
        activeBranch: activeBranch !== undefined ? activeBranch : current.activeBranch,
        status: status !== undefined ? status : current.status,
        lastCommitHash: lastCommitHash !== undefined ? lastCommitHash : current.lastCommitHash,
        lastCommitMessage: lastCommitMessage !== undefined ? lastCommitMessage : current.lastCommitMessage,
        lastActivityTime: new Date().toISOString(),
        stabilizationTimer: stabilizationTimer !== undefined ? stabilizationTimer : current.stabilizationTimer,
        reviewsCount: reviewsCount !== undefined ? reviewsCount : current.reviewsCount,
        triggerMode: triggerMode !== undefined ? triggerMode : current.triggerMode,
        quietPeriodSeconds: quietPeriodSeconds !== undefined ? quietPeriodSeconds : current.quietPeriodSeconds,
        branchPattern: branchPattern !== undefined ? branchPattern : current.branchPattern
      }
    });

    const targetStatus = status !== undefined ? status : current.status;
    const targetBranch = activeBranch !== undefined ? activeBranch : current.activeBranch;
    if (targetStatus === 'stabilizing' && targetBranch) {
      const prId = `real-pr-${id}-${targetBranch.replace(/\//g, "-")}`;
      await prisma.pullRequest.updateMany({ where: { id: prId }, data: { status: 'In Progress' } });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error updating repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await prisma.repository.deleteMany({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Error unlinking repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
