import { createHash } from "node:crypto";
import { persistReviewArtifact } from "../durableScanState";

export const EXECUTION_EVIDENCE_LIMIT = 12_000;

export interface ToolchainEvidenceMetadata {
  readonly ecosystem: string | null;
  readonly runtime: Readonly<Record<string, string>>;
  readonly image: string | null;
  readonly packageManager?: { readonly name: string; readonly version?: string };
  readonly lockfiles: readonly string[];
  readonly workspace: string;
  readonly workspaces?: unknown;
  readonly commands: readonly string[];
  readonly servicePolicy?: unknown;
  readonly fingerprint: string;
}

export interface ExecutionEvidenceRecord {
  readonly commandId: string;
  readonly phase: "install" | "quality" | "service";
  readonly command: string;
  readonly cwd?: string;
  readonly status: "passed" | "failed" | "timed_out" | "skipped";
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly timedOut: boolean;
  readonly retryCount: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

function clipped(value: string): string {
  return value.length > EXECUTION_EVIDENCE_LIMIT
    ? `${value.slice(0, EXECUTION_EVIDENCE_LIMIT)}\n[truncated]`
    : value;
}

function redact(value: string, secretValues: readonly string[]): string {
  let result = value;
  for (const secret of secretValues.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(\b(?:token|password|secret|api[_-]?key|private[_-]?key)\s*[=:]\s*)[^\s&"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function commandId(command: string, cwd = ""): string {
  return createHash("sha256").update(`${cwd}\0${command}`).digest("hex").slice(0, 24);
}

export function redactExecutionEvidence(
  record: Omit<ExecutionEvidenceRecord, "commandId" | "stdout" | "stderr"> & { stdout: string; stderr: string },
  secretValues: readonly string[] = [],
): ExecutionEvidenceRecord {
  return {
    ...record,
    commandId: commandId(record.command, record.cwd),
    command: redact(record.command, secretValues),
    stdout: clipped(redact(record.stdout, secretValues)),
    stderr: clipped(redact(record.stderr, secretValues)),
  };
}

export function recordExecutionResult(input: {
  phase: ExecutionEvidenceRecord["phase"];
  command: string;
  cwd?: string;
  startedAt: Date;
  result: { exitCode: number; signal?: string | null; timedOut: boolean; stdout: string; stderr: string };
  retryCount?: number;
}): ExecutionEvidenceRecord {
  return redactExecutionEvidence({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    status: input.result.timedOut ? "timed_out" : input.result.exitCode === 0 ? "passed" : "failed",
    exitCode: input.result.exitCode,
    signal: input.result.signal,
    timedOut: input.result.timedOut,
    retryCount: input.retryCount ?? 0,
    stdout: input.result.stdout,
    stderr: input.result.stderr,
    startedAt: input.startedAt.toISOString(),
    completedAt: new Date().toISOString(),
  }, []);
}

export function sanitizeToolchainMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeToolchainMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(secret|token|password|credential|pat|deploykey|privatekey|api[_-]?key)/i.test(key))
    .map(([key, item]) => [key, sanitizeToolchainMetadata(item)]));
}

export async function persistExecutionEvidence(input: {
  reviewRunId: string;
  reviewChunkId?: string;
  toolchain: ToolchainEvidenceMetadata;
  records: readonly ExecutionEvidenceRecord[];
}): Promise<void> {
  await persistReviewArtifact({
    reviewRunId: input.reviewRunId,
    reviewChunkId: input.reviewChunkId,
    artifactKey: "deterministic-execution",
    kind: "deterministic-execution",
    content: {
      toolchain: sanitizeToolchainMetadata(input.toolchain),
      records: input.records.map((record) => ({ ...record, stdout: clipped(record.stdout), stderr: clipped(record.stderr) })),
      limits: { outputChars: EXECUTION_EVIDENCE_LIMIT },
    },
  });
}
