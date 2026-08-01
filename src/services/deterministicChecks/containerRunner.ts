import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";
import { gitService } from "@/src/lib/gitService";
import type { DeterministicFinding } from "./types";
import { skippedFinding } from "./helpers";
import { parseTscOutput, parseEslintJson } from "./parsers";
import { logReview } from "./logging";

export interface ContainerizedCheckOptions {
  repoId: string;
  cloneUrl: string;
  /** Tip head SHA — must match commit identity / tools. */
  commitHash: string;
  deployKey?: string;
  pat?: string;
  runnerImage: string;
  installCommand: string;
  testCommand: string;
  prId: string;
  reviewRunId?: string;
  reviewChunkId?: string;
  /**
   * Local-only tip tree host path. When set, bind-mounts instead of
   * git sync (avoids empty clone URL pretend-sync).
   */
  hostBindPath?: string;
}

function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
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
    const result = await orchestrator.runRunner({
      ...mountOpts,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      networkMode: "bridge",
    });
    logs.push(`[install] exit=${result.exitCode} stdout=${result.stdout.slice(0, 2000)} stderr=${result.stderr.slice(0, 2000)}`);
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

  const runTest = async (): Promise<DeterministicFinding[]> => {
    const cmd = opts.testCommand.trim();
    if (!cmd) return [];
    void logReview(
      opts.prId,
      `Containerized checks: running tests (${opts.testCommand})...`,
      "info",
      opts.reviewRunId,
      opts.reviewChunkId,
    );
    const result = await orchestrator.runRunner({
      ...mountOpts,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      networkMode: "none",
    });
    logs.push(`[test] exit=${result.exitCode} stdout=${result.stdout.slice(0, 2000)} stderr=${result.stderr.slice(0, 2000)}`);

    if (result.exitCode === 0 && !result.timedOut) return [];

    const combined = `${result.stdout}\n${result.stderr}`;

    const tscFindings = parseTscOutput(combined);
    if (tscFindings.length > 0) return tscFindings;

    const eslintFindings = parseEslintJson(result.stdout);
    if (eslintFindings.length > 0) return eslintFindings;

    const genericFindings = parseGenericErrors(combined);
    if (genericFindings.length > 0) return genericFindings;

    if (result.timedOut) {
      return [skippedFinding("tsc", "Test command timed out after 300s")];
    }

    return [
      {
        filename: "<tooling>",
        line: null,
        severity: "info",
        category: "Skipped",
        explanation: `Test command exited with code ${result.exitCode} but output could not be parsed. Check runner logs for details.`,
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
    throw err;
  }

  const testFindings = await runTest();
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

  return findings;
}
