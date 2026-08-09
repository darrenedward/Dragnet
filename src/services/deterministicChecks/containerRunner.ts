import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";
import { gitService } from "@/src/lib/gitService";
import type { DeterministicFinding } from "./types";
import { DEFAULT_TEST_COMMAND, resolveQualityCommand, skippedFinding } from "./helpers";
import { parseTscOutput, parseEslintJson } from "./parsers";
import { logReview } from "./logging";
import type { CheckKind, ResolvedQualityCommand } from "./toolchainResolver";
import { planQualityChecks, buildTimeEnvironment } from "./qualityPlan";
import { serviceEnvironment, type DisposableServicePlan } from "./disposableServices";
import { persistExecutionEvidence, recordExecutionResult, type ToolchainEvidenceMetadata, type ExecutionEvidenceRecord } from "./executionEvidence";

export interface ContainerizedCheckOptions {
  repoId: string;
  cloneUrl: string;
  /** Tip head SHA — must match commit identity / tools. */
  commitHash: string;
  deployKey?: string;
  pat?: string;
  runnerImage: string;
  installCommand: string;
  testCommand?: string | null;
  prId: string;
  reviewRunId?: string;
  reviewChunkId?: string;
  /**
   * Local-only tip tree host path. When set, bind-mounts instead of
   * git sync (avoids empty clone URL pretend-sync).
   */
  hostBindPath?: string;
  /** Resolved tip checks. When supplied, legacy root-script discovery is bypassed. */
  qualityChecks?: Readonly<Record<CheckKind, readonly ResolvedQualityCommand[]>>;
  availableServices?: ReadonlySet<string>;
  installEnvironment?: Readonly<Record<string, string>>;
  /** Network created by the disposable-service lifecycle, when checks require services. */
  qualityNetworkMode?: string;
  servicePlan?: DisposableServicePlan;
  toolchainMetadata?: ToolchainEvidenceMetadata;
}

export const QUALITY_CHECK_NETWORK_MODE = "none" as const;

function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
}

function parsePackageScripts(stdout: string): Record<string, string> | null {
  try {
    const packageJson = JSON.parse(stdout) as { scripts?: unknown };
    if (!packageJson.scripts || typeof packageJson.scripts !== "object") return {};
    return Object.fromEntries(
      Object.entries(packageJson.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return null;
  }
}

export function parseGenericErrors(stderr: string): DeterministicFinding[] {
  const diagnostics: DeterministicFinding[] = [];
  const lines = stderr.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const fileMatch = line.match(/^(?:error|Error|ERROR)\s*(.*?):\s*(.+)$/);
    if (fileMatch) {
      diagnostics.push({
        filename: fileMatch[1] || "<output>",
        line: 0,
        severity: "error",
        category: "Build Error",
        explanation: fileMatch[2],
        source: "runner",
      });
    }
  }
  return diagnostics;
}

export async function runContainerizedChecks(
  opts: ContainerizedCheckOptions,
): Promise<DeterministicFinding[]> {
  const vn = volumeName(opts.repoId);
  const findings: DeterministicFinding[] = [];
  const logs: string[] = [];
  const evidence: ExecutionEvidenceRecord[] = [];
  const hostBindPath = (opts.hostBindPath ?? "").trim() || undefined;
  const cloneUrl = (opts.cloneUrl ?? "").trim();

  // Local-only without bind path: never pretend-sync with empty clone URL.
  if (!hostBindPath && !cloneUrl) {
    const msg =
      "Tier 2 skipped: local-only repo has no clone URL and no tip bind path (not empty-URL pretend-sync)";
    void logReview(opts.prId, msg, "info", opts.reviewRunId, opts.reviewChunkId);
    return [skippedFinding("runner", msg)];
  }

  if (hostBindPath) {
    void logReview(
      opts.prId,
      `Containerized checks: bind-mount tip tree at ${hostBindPath} (head ${opts.commitHash.slice(0, 12)})...`,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );
  } else {
    void logReview(
      opts.prId,
      `Containerized checks: syncing repository to commit ${opts.commitHash.slice(0, 12)}...`,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );

    try {
      await gitService.syncToCommit({
        repoId: opts.repoId,
        volumeName: vn,
        cloneUrl,
        commitHash: opts.commitHash,
        deployKey: opts.deployKey,
        pat: opts.pat,
      });
    } catch (err: any) {
      void logReview(
        opts.prId,
        `Containerized checks: git sync failed — ${err.message}`,
        "warn",
        opts.reviewRunId,
        opts.reviewChunkId,
      );
      return [skippedFinding("tsc", `Git sync failed: ${err.message}`)];
    }
  }

  const orchestrator = ContainerOrchestrator.getInstance();
  const mountOpts = hostBindPath
    ? { hostBindPath }
    : { volumeName: vn };

  const readPackageScripts = async (): Promise<Record<string, string> | null> => {
    const result = await orchestrator.runRunner({
      ...mountOpts,
      image: opts.runnerImage,
      commands: ["cat package.json"],
      timeoutMs: 10_000,
      networkMode: QUALITY_CHECK_NETWORK_MODE,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    return parsePackageScripts(result.stdout);
  };

  const runInstall = async (): Promise<void> => {
    const cmd = opts.installCommand.trim();
    if (!cmd) return;
    void logReview(
      opts.prId,
      `Containerized checks: installing dependencies (${opts.installCommand})...`,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );
    // Do not pass cpuLimit/memoryLimit — orchestrator applies DRAGNET_RUNNER_*
    // env (or no cap). Hardcoding --cpus 2 breaks 1-vCPU Dokploy hosts (exit 125).
    const startedAt = new Date();
    const result = await orchestrator.runRunner({
      ...mountOpts,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      networkMode: "bridge",
      // Prisma's generate step reads DATABASE_URL from its config but does
      // not connect to Postgres. Give install lifecycle hooks a non-routable
      // placeholder without exposing any host or repository credentials.
      ...(opts.installEnvironment ? { environment: opts.installEnvironment } : { provideSyntheticDatabaseUrl: true }),
    });
    evidence.push(recordExecutionResult({ phase: "install", command: cmd, startedAt, result }));
    const installEvidence = evidence[evidence.length - 1];
    logs.push(`[install] exit=${result.exitCode} stdout=${installEvidence.stdout} stderr=${installEvidence.stderr}`);
    if (result.timedOut) {
      const msg = `Containerized checks: install timed out after 300s (${opts.installCommand})`;
      void logReview(opts.prId, msg, "error", opts.reviewRunId, opts.reviewChunkId);
      throw new Error(msg);
    }
    if (result.exitCode !== 0) {
      const msg = `Containerized checks: install failed (exit ${result.exitCode}) — aborting before quality gates and LLM`;
      void logReview(opts.prId, msg, "error", opts.reviewRunId, opts.reviewChunkId);
      throw new Error(msg);
    }
  };

  const runQualityChecks = async (): Promise<DeterministicFinding[]> => {
    if (opts.testCommand === "") return [];
    if (opts.qualityChecks) {
      const planned = planQualityChecks(opts.qualityChecks, opts.availableServices ?? new Set());
      const findings: DeterministicFinding[] = [];
      for (const item of planned) {
        if (item.status === "skipped_dependency") {
          void logReview(opts.prId, `Containerized checks: skipped ${item.command.command} — ${item.reason}`, "info", opts.reviewRunId, opts.reviewChunkId);
          continue;
        }
        if (item.status === "infrastructure_failure") {
          findings.push(skippedFinding("runner", item.reason ?? "Required quality service unavailable"));
          continue;
        }
        const result = await orchestrator.runRunner({
          ...mountOpts,
          image: opts.runnerImage,
          commands: [item.command.command],
          workingDirectory: item.command.cwd,
          environment: {
            ...buildTimeEnvironment(item.command),
            ...(opts.servicePlan ? serviceEnvironment(item.command, opts.servicePlan) : {}),
          },
          timeoutMs: 300_000,
          networkMode: item.command.requiresServices.length > 0
            ? (opts.qualityNetworkMode ?? QUALITY_CHECK_NETWORK_MODE)
            : QUALITY_CHECK_NETWORK_MODE,
        });
        evidence.push(recordExecutionResult({ phase: "quality", command: item.command.command, cwd: item.command.cwd, startedAt: new Date(), result }));
        const qualityEvidence = evidence[evidence.length - 1];
        logs.push(`[${item.command.kind}] exit=${result.exitCode} stdout=${qualityEvidence.stdout} stderr=${qualityEvidence.stderr}`);
        if (result.exitCode === 0 && !result.timedOut) continue;
        const combined = `${result.stdout}\n${result.stderr}`;
        findings.push(...parseTscOutput(combined), ...parseEslintJson(result.stdout), ...parseGenericErrors(combined));
        if (findings.length === 0) findings.push(skippedFinding("runner", `Quality command failed: ${item.command.command}`));
      }
      return findings;
    }
    const scripts = (opts.testCommand == null || opts.testCommand.trim() === DEFAULT_TEST_COMMAND)
      ? await readPackageScripts()
      : null;
    const cmd = resolveQualityCommand({ configuredCommand: opts.testCommand, scripts });
    if (!cmd) return [];
    void logReview(
      opts.prId,
      `Containerized checks: running quality checks (${cmd})...`,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );
    const startedAt = new Date();
    const result = await orchestrator.runRunner({
      ...mountOpts,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      networkMode: QUALITY_CHECK_NETWORK_MODE,
    });
    evidence.push(recordExecutionResult({ phase: "quality", command: cmd, startedAt, result }));
    const qualityEvidence = evidence[evidence.length - 1];
    logs.push(`[quality] exit=${result.exitCode} stdout=${qualityEvidence.stdout} stderr=${qualityEvidence.stderr}`);

    if (result.exitCode === 0 && !result.timedOut) return [];

    const combined = `${result.stdout}\n${result.stderr}`;

    const tscFindings = parseTscOutput(combined);
    if (tscFindings.length > 0) return tscFindings;

    const eslintFindings = parseEslintJson(result.stdout);
    if (eslintFindings.length > 0) return eslintFindings;

    const genericFindings = parseGenericErrors(combined);
    if (genericFindings.length > 0) return genericFindings;

    if (result.timedOut) {
      return [skippedFinding("runner", `Quality command timed out after 300s: ${cmd}`)];
    }

    return [
      {
        filename: "<tooling>",
        line: null,
        severity: "info",
        category: "Skipped",
        explanation: `Quality command exited with code ${result.exitCode} but output could not be parsed: ${cmd}. Check runner logs for details.`,
        source: "runner",
      },
    ];
  };

  try {
    await runInstall();
  } catch (err) {
    for (const log of logs) {
      void logReview(opts.prId, log, "info", opts.reviewRunId, opts.reviewChunkId);
    }
    if (opts.reviewRunId && opts.toolchainMetadata) {
      await persistExecutionEvidence({
        reviewRunId: opts.reviewRunId,
        reviewChunkId: opts.reviewChunkId,
        toolchain: { ...opts.toolchainMetadata, ...(opts.servicePlan ? { servicePolicy: opts.servicePlan } : {}) },
        records: evidence,
      });
    }
    throw err;
  }

  const testFindings = await runQualityChecks();
  findings.push(...testFindings);

  const logSummary = findings.length === 0
    ? "clean (no findings)"
    : findings.map((f) => `${f.source}:${f.filename}`).join(", ");

  void logReview(
    opts.prId,
    `Containerized checks: ${logSummary}`,
    "info",
    opts.reviewRunId,
    opts.reviewChunkId,
  );

  for (const log of logs) {
    void logReview(
      opts.prId,
      log,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );
  }

  if (opts.reviewRunId && opts.toolchainMetadata) {
    await persistExecutionEvidence({
      reviewRunId: opts.reviewRunId,
      reviewChunkId: opts.reviewChunkId,
      toolchain: { ...opts.toolchainMetadata, ...(opts.servicePlan ? { servicePolicy: opts.servicePlan } : {}) },
      records: evidence,
    });
  }

  return findings;
}
