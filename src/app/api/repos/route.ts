import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { getRealLocalPrs } from "@/src/lib/getRealLocalPrs";

export async function GET() {
  try {
    const reposRaw = await prisma.repository.findMany({
      include: { _count: { select: { pullRequests: true } } },
    });
    const repos = reposRaw.map(r => ({ ...r, prCount: r._count.pullRequests }));
    return NextResponse.json(repos);
  } catch (err: any) {
    console.error("Error fetching repositories:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, name, path: repoPath, baseBranch, activeBranch, triggerMode, quietPeriodSeconds, branchPattern } = body;

    if (!repoPath || typeof repoPath !== "string") {
      return NextResponse.json(
        { error: "Path is required." },
        { status: 400 },
      );
    }

    // Pre-check for an existing link at this path. The DB also has a unique
    // constraint on `path` (defense in depth against races), but this lets us
    // return a friendly "already linked as X" message instead of a generic
    // constraint-violation error.
    const existing = await prisma.repository.findFirst({
      where: { path: repoPath },
      select: { id: true, name: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: `Directory "${repoPath}" is already linked as project "${existing.name}". Each directory can only be linked once.`,
          existingId: existing.id,
          existingName: existing.name,
        },
        { status: 409 },
      );
    }

    const cleanId = id || name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now();

    try {
      await prisma.repository.create({
        data: {
          id: cleanId,
          name: name,
          path: repoPath,
          baseBranch: baseBranch || "main",
          activeBranch: activeBranch || baseBranch || "main",
          triggerMode: triggerMode || "auto",
          quietPeriodSeconds: quietPeriodSeconds || 10,
          branchPattern: branchPattern || "*",
          status: 'idle',
          lastCommitHash: 'a1b2c3d',
          lastCommitMessage: 'initial repository watch link',
          lastActivityTime: new Date().toISOString(),
          stabilizationTimer: 0,
          reviewsCount: 0
        }
      });
    } catch (createErr: any) {
      // P2002 = unique constraint violation. Catches the race where two
      // POSTs pass the pre-check simultaneously before one commits.
      if (createErr?.code === "P2002") {
        const racer = await prisma.repository.findFirst({
          where: { path: repoPath },
          select: { id: true, name: true },
        });
        return NextResponse.json(
          {
            error: `Directory "${repoPath}" was just linked as project "${racer?.name || "unknown"}" — duplicate prevented.`,
            existingId: racer?.id,
            existingName: racer?.name,
          },
          { status: 409 },
        );
      }
      throw createErr;
    }

    await getRealLocalPrs(repoPath, cleanId);

    return NextResponse.json({ success: true, id: cleanId }, { status: 201 });
  } catch (err: any) {
    console.error("Error inserting repository:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
