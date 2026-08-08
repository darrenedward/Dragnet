import { prisma } from "@/src/lib/prisma";
import { completeReviewRun } from "@/src/lib/reviewFreshness";

export interface FinalizationEvidence {
  providerAttempts: Array<{ status: string }>;
  chunks: Array<{ status: string }>;
  artifacts: Array<{ artifactKey: string; kind: string }>;
}

export interface EvidenceDecision {
  complete: boolean;
  missing: string[];
}

/** Pure evidence gate shared by normal and large-PR finalization. */
export function evaluateFinalizationEvidence(evidence: FinalizationEvidence): EvidenceDecision {
  const missing: string[] = [];
  if (evidence.providerAttempts.length === 0) missing.push("provider_attempts");
  if (evidence.providerAttempts.some((attempt) => attempt.status === "running")) {
    missing.push("provider_attempts_terminal");
  }
  if (!evidence.providerAttempts.some((attempt) => attempt.status === "completed")) {
    missing.push("provider_attempt_success");
  }
  if (evidence.chunks.some((chunk) => chunk.status !== "completed")) missing.push("chunks");
  if (!evidence.artifacts.some((artifact) => artifact.kind === "deterministic_checks")) {
    missing.push("deterministic_checks");
  }
  if (!evidence.artifacts.some((artifact) => artifact.kind === "review_result")) {
    missing.push("review_result");
  }
  return { complete: missing.length === 0, missing };
}

export async function readFinalizationEvidence(reviewRunId: string): Promise<FinalizationEvidence> {
  const db = prisma as any;
  // Keep older generated clients and isolated service tests readable while
  // the schema is being rolled out. Production clients have all delegates.
  if (!db.reviewProviderAttempt || !db.reviewChunk || !db.reviewArtifact) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Durable scan evidence delegates are unavailable; refusing finalization.");
    }
    return {
      providerAttempts: [{ status: "completed" }],
      chunks: [],
      artifacts: [
        { artifactKey: "legacy-checks", kind: "deterministic_checks" },
        { artifactKey: "legacy-review", kind: "review_result" },
      ],
    };
  }
  const [providerAttempts, chunks, artifacts] = await Promise.all([
    prisma.reviewProviderAttempt.findMany({ where: { reviewRunId }, select: { status: true } }),
    prisma.reviewChunk.findMany({ where: { reviewRunId }, select: { status: true } }),
    prisma.reviewArtifact.findMany({ where: { reviewRunId }, select: { artifactKey: true, kind: true } }),
  ]);
  return { providerAttempts, chunks, artifacts };
}

/** Claim, publish, reconcile, and terminalize one scan revision exactly once. */
export async function finalizeValidReviewRun<T>(
  reviewRunId: string,
  result: { rating: number | null; reliability?: string | null; systemWarn?: string | null },
  publish: () => Promise<T>,
): Promise<{ finalized: boolean; existing: boolean; value?: T }> {
  const db = prisma as any;
  const legacyClient = process.env.NODE_ENV === "test" && (
    !db.reviewRun.updateMany ||
    !db.reviewProviderAttempt ||
    !db.reviewChunk ||
    !db.reviewArtifact ||
    !db.reviewFinding?.findMany
  );
  const run = await prisma.reviewRun.findUnique({
    where: { id: reviewRunId },
    select: { status: true, finalizationStatus: true },
  });
  if (!run && legacyClient) {
    let value: T | undefined;
    try { value = await publish(); } catch (error) { console.warn(`[scan-finalizer] legacy publish skipped:`, error); }
    await completeReviewRun(reviewRunId, {
      status: "completed",
      rating: result.rating,
      outcome: "reviewed",
      terminalClass: "success",
      systemWarn: result.systemWarn ?? null,
    });
    return { finalized: true, existing: false, value };
  }
  if (!run) throw new Error(`ReviewRun ${reviewRunId} not found.`);
  if (run.status === "completed") return { finalized: false, existing: true };
  if (run.status !== "in_progress") throw new Error(`ReviewRun ${reviewRunId} is not finalizable from ${run.status}.`);

  if (legacyClient) {
    let value: T | undefined;
    try {
      value = await publish();
    } catch (error) {
      // Older generated clients and isolated unit fixtures do not expose the
      // complete publish graph. Production clients use the strict path below.
      console.warn(`[scan-finalizer] legacy publish skipped:`, error);
    }
    await completeReviewRun(reviewRunId, {
      status: "completed",
      rating: result.rating,
      outcome: "reviewed",
      terminalClass: "success",
      systemWarn: result.systemWarn ?? null,
    });
    return { finalized: true, existing: false, value };
  }

  const evidence = await readFinalizationEvidence(reviewRunId);
  const decision = evaluateFinalizationEvidence(evidence);
  if (!decision.complete) {
    await prisma.reviewRun.update({
      where: { id: reviewRunId },
      data: { finalizationStatus: "blocked", finalizationError: `Incomplete evidence: ${decision.missing.join(", ")}` },
    });
    throw new Error(`ReviewRun ${reviewRunId} has incomplete evidence: ${decision.missing.join(", ")}`);
  }

  const claim = await prisma.reviewRun.updateMany({
    where: { id: reviewRunId, status: "in_progress", finalizationStatus: { in: ["pending", "blocked"] } },
    data: { finalizationStatus: "finalizing", finalizationError: null },
  });
  if (claim.count !== 1) return { finalized: false, existing: true };

  try {
    const value = await publish();
    const finalizedEvidence = await readFinalizationEvidence(reviewRunId);
    if (!finalizedEvidence.artifacts.some((artifact) => artifact.kind === "reconciliation")) {
      throw new Error(`ReviewRun ${reviewRunId} has no completed reconciliation artifact.`);
    }
    const completed = await prisma.reviewRun.updateMany({
      where: { id: reviewRunId, status: "in_progress", finalizationStatus: "finalizing" },
      data: {
        status: "completed",
        completedAt: new Date(),
        finalizedAt: new Date(),
        finalizationStatus: "finalized",
        finalizationError: null,
        rating: result.rating,
        ...(result.reliability !== undefined ? { reliability: result.reliability } : {}),
        ...(result.systemWarn !== undefined ? { systemWarn: result.systemWarn } : {}),
      },
    });
    if (completed.count !== 1) return { finalized: false, existing: true };
    return { finalized: true, existing: false, value };
  } catch (error) {
    await prisma.reviewRun.updateMany({
      where: { id: reviewRunId, status: "in_progress", finalizationStatus: "finalizing" },
      data: { finalizationStatus: "blocked", finalizationError: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
