import { prisma } from "@/src/lib/prisma";
import { diffResolvedFindings, identityTuple } from "./diffFindings";
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
      // Reconciliation runs immediately before this tracker. Restricting to
      // findings it marked resolved prevents a missing finding caused by a
      // partial/failed scan from being counted as a user fix.
      where: { reviewRunId: priorRun.id, status: "resolved" },
      select: { id: true, filename: true, line: true, category: true, severity: true },
    }),
  ]);

  const fixed = diffResolvedFindings(priorFindings as FindingShape[], currentFindings as FindingShape[]);

  if (fixed.length === 0) {
    return { written: 0, skipped: 0 };
  }

  const priorMap = new Map(priorFindings.map((f) => {
    return [identityTuple(f), f.id] as const;
  }));

  let written = 0;
  let skipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const finding of fixed) {
      try {
        const key = identityTuple(finding);
        await tx.bugFixEvent.create({
          data: {
            prId: run.prId,
            fixedAtScanId: reviewRunId,
            originatedAtScanId: priorRun.id,
            sourceFindingId: priorMap.get(key) ?? null,
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
          throw err;
        }
      }
    }
  });

  return { written, skipped };
}
