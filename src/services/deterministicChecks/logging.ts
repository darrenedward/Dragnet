import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/prisma";

export async function logReview(
  prId: string,
  message: string,
  level: string = "info",
  reviewRunId?: string,
  reviewChunkId?: string,
): Promise<void> {
  try {
    await prisma.reviewLog.create({
      data: {
        id: randomUUID(),
        prId,
        reviewRunId: reviewRunId ?? null,
        reviewChunkId: reviewChunkId ?? null,
        message,
        level,
      },
    });
  } catch {
    // Best-effort — never break the review for a log write failure.
  }
}
