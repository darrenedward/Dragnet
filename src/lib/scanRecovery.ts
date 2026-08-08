export interface ScanRecoveryAttempt {
  id?: string;
  correlationId?: string | null;
  provider?: string;
  model?: string;
  status: string;
  outcome?: string | null;
  errorClass?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  checkpointPosition?: number | null;
  resumed?: boolean;
  superseded?: boolean;
}

export interface ScanRecoveryState {
  lifecycle: string;
  providerNeutral: {
    status: string;
    outcome?: string | null;
    reliability?: string | null;
    finalization: { status?: string | null; error?: string | null; finalizedAt?: string | null };
  };
  attempts: ScanRecoveryAttempt[];
  artifacts: Array<{ key: string; kind: string; version?: number | null; updatedAt?: string | null }>;
  checkpoints: unknown[];
  chunks: unknown[];
}
