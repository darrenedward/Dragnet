import { prisma } from "@/src/lib/prisma";
import { diffBlockerFixes } from "./diffFindings";
import type { FindingShape } from "./diffFindings";

export interface RecordFixesResult {
  written: number;
  skipped: number;
}

export async function recordFixesForCompletedScan(
  reviewRunId: string,
): Promise<RecordFixesResult> {
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { prId: true, outcome: true, status: true },
  });

  if (!run || run.status !== "completed" || run.outcome === "skipped") {
    return { written: 0, skipped: 0 };
  }

  const priorRun = await prisma.reviewRun.findFirst({
    where: {
      prId: run.prId,
      status: "completed",
      outcome: { not: "skipped" },
      id: { not: reviewRunId },
    },
    orderBy: { completedAt: "desc" },
    select: { id: true },
  });

  if (!priorRun) {
    return { written: 0, skipped: 0 };
  }

  const [currentFindings, priorFindings] = await Promise.all([
    prisma.reviewFinding.findMany({
      where: { reviewRunId },
      select: { filename: true, line: true, category: true, severity: true },
    }),
    prisma.reviewFinding.findMany({
      where: { reviewRunId: priorRun.id },
      select: { filename: true, line: true, category: true, severity: true },
    }),
  ]);

  const fixed = diffBlockerFixes(priorFindings as FindingShape[], currentFindings as FindingShape[]);

  if (fixed.length === 0) {
    return { written: 0, skipped: 0 };
  }

  let written = 0;
  let skipped = 0;

  for (const finding of fixed) {
    try {
      await prisma.bugFixEvent.create({
        data: {
          prId: run.prId,
          fixedAtScanId: reviewRunId,
          originatedAtScanId: priorRun.id,
          filename: finding.filename,
          line: finding.line ?? null,
          category: finding.category,
          severity: finding.severity,
        },
      });
      written++;
    } catch (err: any) {
      if (err?.code === "P2002") {
        skipped++;
      } else {
        console.warn(
          `[bugFixTracker] failed to write BugFixEvent for ${finding.filename}:${finding.line}:`,
          err,
        );
      }
    }
  }

  return { written, skipped };
}
