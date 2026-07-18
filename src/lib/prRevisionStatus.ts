import { prisma } from "./prisma";

/** A completed review is current only while the PR still points at its commit. */
export function statusForRevision(
  status: string | undefined,
  previousCommit: string | undefined,
  currentCommit: string,
): string {
  return status === "Completed" && previousCommit !== currentCommit
    ? "Pending"
    : status || "Pending";
}

/**
 * Finish a scan without allowing an older scan to win a revision race.
 * Returns true when this scan completed the currently stored revision.
 */
export async function completePrReviewIfCurrent(
  prId: string,
  scannedCommit: string,
  rating?: number | null,
): Promise<boolean> {
  const completed = await prisma.pullRequest.updateMany({
    where: { id: prId, commitHash: scannedCommit },
    data: { status: "Completed", ...(rating === undefined ? {} : { rating }) },
  });
  if (completed.count > 0) return true;

  const client = prisma as typeof prisma & {
    reviewRun?: {
      findFirst(args: unknown): Promise<{ commitHash: string } | null>;
    };
  };
  const activeRun = client.reviewRun
    ? await client.reviewRun.findFirst({
        where: { prId, status: "in_progress" },
        orderBy: { startedAt: "desc" },
        select: { commitHash: true },
      })
    : null;
  if (activeRun?.commitHash !== undefined && activeRun.commitHash !== scannedCommit) {
    return false;
  }

  await prisma.pullRequest.updateMany({
    where: {
      id: prId,
      commitHash: { not: scannedCommit },
      status: { notIn: ["Merged", "Failed"] },
    },
    data: { status: "Pending" },
  });
  return false;
}
