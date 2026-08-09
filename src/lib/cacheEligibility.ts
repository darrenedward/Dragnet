export type CacheIneligibilityReason =
  | "commit_mismatch"
  | "diff_mismatch"
  | "config_mismatch"
  | "toolchain_mismatch"
  | "incomplete_chunks"
  | "contradictory_chunks";

export interface CacheEligibilityInput {
  readonly run: {
    readonly status: string;
    readonly commitHash: string;
    readonly diffHash: string;
    readonly reviewConfigHash: string;
    readonly toolchainFingerprint?: string | null;
    readonly chunksTotal?: number | null;
  };
  readonly current: {
    readonly commitHash: string;
    readonly diffHash: string;
    readonly reviewConfigHash: string;
    readonly toolchainFingerprint?: string | null;
  };
  readonly chunks?: readonly { readonly status: string | null | undefined }[];
}

export interface CacheEligibilityResult {
  readonly eligible: boolean;
  readonly reason?: CacheIneligibilityReason;
  readonly message?: string;
}

export function evaluateCacheEligibility(input: CacheEligibilityInput): CacheEligibilityResult {
  if (input.run.commitHash !== input.current.commitHash) return { eligible: false, reason: "commit_mismatch", message: "The completed run targets a different commit." };
  if (!input.current.diffHash || input.run.diffHash !== input.current.diffHash) return { eligible: false, reason: "diff_mismatch", message: "The diff changed since the completed run." };
  if (input.run.reviewConfigHash !== input.current.reviewConfigHash) return { eligible: false, reason: "config_mismatch", message: "The review configuration changed since the completed run." };
  if (input.current.toolchainFingerprint !== undefined && input.run.toolchainFingerprint !== input.current.toolchainFingerprint) {
    return { eligible: false, reason: "toolchain_mismatch", message: "The resolved toolchain changed since the completed run." };
  }
  const expected = input.run.chunksTotal ?? 0;
  if (expected > 0) {
    const chunks = input.chunks ?? [];
    if (chunks.length !== expected) return { eligible: false, reason: "incomplete_chunks", message: `Chunk coverage is incomplete: ${chunks.length}/${expected} records exist.` };
    if (chunks.some((chunk) => chunk.status !== "completed")) {
      return { eligible: false, reason: "contradictory_chunks", message: "The run is marked completed but one or more chunks are not completed." };
    }
  }
  return { eligible: true };
}
