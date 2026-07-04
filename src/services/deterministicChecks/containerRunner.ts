import { ContainerOrchestrator } from "@/src/lib/containerOrchestrator";
import { gitService } from "@/src/lib/gitService";
import type { DeterministicFinding } from "./types";
import { skippedFinding } from "./helpers";
import { parseTscOutput, parseEslintJson } from "./parsers";
import { logReview } from "./logging";

export interface ContainerizedCheckOptions {
  repoId: string;
  cloneUrl: string;
  commitHash: string;
  deployKey?: string;
  pat?: string;
  runnerImage: string;
  installCommand: string;
  testCommand: string;
  prId: string;
  reviewRunId?: string;
  reviewChunkId?: string;
}

function volumeName(repoId: string): string {
  return `dragnet-repo-${repoId}`;
}

function parseGenericErrors(stderr: string): DeterministicFinding[] {
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
        source: "tsc",
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

  try {
    await gitService.syncToCommit({
      repoId: opts.repoId,
      volumeName: vn,
      cloneUrl: opts.cloneUrl,
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

  const orchestrator = ContainerOrchestrator.getInstance();

  const runInstall = async (): Promise<boolean> => {
    const cmd = opts.installCommand.trim();
    if (!cmd) return true;
    const result = await orchestrator.runRunner({
      volumeName: vn,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      memoryLimit: "4g",
      cpuLimit: "2",
    });
    logs.push(`[install] exit=${result.exitCode} stdout=${result.stdout.slice(0, 2000)} stderr=${result.stderr.slice(0, 2000)}`);
    if (result.exitCode !== 0 && !result.timedOut) {
      void logReview(
        opts.prId,
        `Containerized checks: install failed (exit ${result.exitCode})`,
        "warn",
        opts.reviewRunId,
        opts.reviewChunkId,
      );
    }
    return result.exitCode === 0 || result.timedOut;
  };

  const runTest = async (): Promise<DeterministicFinding[]> => {
    const cmd = opts.testCommand.trim();
    if (!cmd) return [];
    const result = await orchestrator.runRunner({
      volumeName: vn,
      image: opts.runnerImage,
      commands: [cmd],
      timeoutMs: 300_000,
      memoryLimit: "4g",
      cpuLimit: "2",
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
        source: "tsc",
      },
    ];
  };

  const installOk = await runInstall();

  if (installOk) {
    const testFindings = await runTest();
    findings.push(...testFindings);
  }

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
