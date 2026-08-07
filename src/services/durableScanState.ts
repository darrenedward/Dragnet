import { createHash } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import type { CheckpointState } from "@/src/services/checkpointStore";
import type { OutcomeClass } from "@/src/lib/failureClassifier";

const db = prisma as any;

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorDetails(error: unknown): { errorClass: string | null; errorMessage: string | null } {
  if (!error) return { errorClass: null, errorMessage: null };
  const value = error as any;
  return {
    errorClass: value?.code || value?.name || "Error",
    errorMessage: String(value?.message ?? error),
  };
}

export interface ProviderAttemptStart {
  reviewRunId: string;
  reviewChunkId?: string;
  attemptKey: string;
  provider: string;
  model: string;
  maxIterations: number;
  startedAt?: Date;
}

export interface ProviderAttemptCompletion {
  reviewRunId: string;
  attemptKey: string;
  status: "completed" | "failed";
  outcome: OutcomeClass;
  error?: unknown;
  iterationsUsed: number;
  maxIterations: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  completedAt?: Date;
}

/** Persisting evidence is best-effort so a telemetry outage cannot fail a review. */
export async function beginProviderAttempt(input: ProviderAttemptStart): Promise<void> {
  if (!db.reviewProviderAttempt) return;
  try {
    await db.reviewProviderAttempt.upsert({
      where: { reviewRunId_attemptKey: { reviewRunId: input.reviewRunId, attemptKey: input.attemptKey } },
      create: {
        id: stableId("attempt", `${input.reviewRunId}:${input.attemptKey}`),
        reviewRunId: input.reviewRunId,
        reviewChunkId: input.reviewChunkId ?? null,
        attemptKey: input.attemptKey,
        provider: input.provider,
        model: input.model,
        status: "running",
        maxIterations: input.maxIterations,
        startedAt: input.startedAt ?? new Date(),
      },
      update: {
        provider: input.provider,
        model: input.model,
        status: "running",
        maxIterations: input.maxIterations,
      },
    });
  } catch (error) {
    console.warn(`[durable-scan] failed to persist provider attempt start:`, error);
  }
}

export async function completeProviderAttempt(input: ProviderAttemptCompletion): Promise<void> {
  if (!db.reviewProviderAttempt) return;
  const details = errorDetails(input.error);
  try {
    await db.reviewProviderAttempt.update({
      where: { reviewRunId_attemptKey: { reviewRunId: input.reviewRunId, attemptKey: input.attemptKey } },
      data: {
        status: input.status,
        outcome: input.outcome,
        errorClass: details.errorClass,
        errorMessage: details.errorMessage,
        iterationsUsed: input.iterationsUsed,
        maxIterations: input.maxIterations,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        costUsd: input.costUsd,
        completedAt: input.completedAt ?? new Date(),
      },
    });
  } catch (error) {
    console.warn(`[durable-scan] failed to persist provider attempt completion:`, error);
  }
}

export async function persistReviewArtifact(input: {
  reviewRunId: string;
  reviewChunkId?: string;
  artifactKey: string;
  kind: string;
  content: unknown;
  version?: number;
}): Promise<void> {
  if (!db.reviewArtifact) return;
  try {
    await db.reviewArtifact.upsert({
      where: { reviewRunId_artifactKey: { reviewRunId: input.reviewRunId, artifactKey: input.artifactKey } },
      create: {
        id: stableId("artifact", `${input.reviewRunId}:${input.artifactKey}`),
        reviewRunId: input.reviewRunId,
        reviewChunkId: input.reviewChunkId ?? null,
        artifactKey: input.artifactKey,
        kind: input.kind,
        version: input.version ?? 1,
        contentHash: hashJson(input.content),
        content: input.content as any,
      },
      update: {
        kind: input.kind,
        version: input.version ?? 1,
        contentHash: hashJson(input.content),
        content: input.content as any,
      },
    });
  } catch (error) {
    console.warn(`[durable-scan] failed to persist artifact ${input.artifactKey}:`, error);
  }
}

export async function persistReviewCheckpoint(state: CheckpointState): Promise<void> {
  if (!db.reviewCheckpoint) return;
  try {
    await db.reviewCheckpoint.upsert({
      where: { reviewRunId_checkpointId: { reviewRunId: state.runId, checkpointId: state.checkpointId } },
      create: {
        id: stableId("checkpoint", `${state.runId}:${state.checkpointId}`),
        reviewRunId: state.runId,
        checkpointId: state.checkpointId,
        version: state.version,
        stateHash: hashJson(state),
        loopCount: state.loopCount,
        provider: state.provider,
        model: state.model,
        state: state as any,
        writtenAt: new Date(state.writtenAt),
      },
      update: {
        version: state.version,
        stateHash: hashJson(state),
        loopCount: state.loopCount,
        provider: state.provider,
        model: state.model,
        state: state as any,
        writtenAt: new Date(state.writtenAt),
      },
    });
  } catch (error) {
    console.warn(`[durable-scan] failed to persist checkpoint ${state.runId}/${state.checkpointId}:`, error);
  }
}

export async function readDurableScanEvidence(reviewRunId: string): Promise<{
  providerAttempts: unknown[];
  artifacts: unknown[];
  checkpoints: unknown[];
}> {
  if (!db.reviewProviderAttempt || !db.reviewArtifact || !db.reviewCheckpoint) {
    return { providerAttempts: [], artifacts: [], checkpoints: [] };
  }
  const [providerAttempts, artifacts, checkpoints] = await Promise.all([
    db.reviewProviderAttempt.findMany({ where: { reviewRunId }, orderBy: { startedAt: "asc" } }),
    db.reviewArtifact.findMany({ where: { reviewRunId }, orderBy: { updatedAt: "asc" } }),
    db.reviewCheckpoint.findMany({ where: { reviewRunId }, orderBy: { writtenAt: "asc" } }),
  ]);
  return { providerAttempts, artifacts, checkpoints };
}
