import { relative } from "node:path";
import type { DeterministicFinding } from "./types";

function tryParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseTscOutput(
  stdout: string,
  source: "tsc" = "tsc",
): DeterministicFinding[] {
  const lines = stdout.split("\n");
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
  const findings: DeterministicFinding[] = [];

  for (const line of lines) {
    const m = line.match(pattern);
    if (!m) continue;
    const [, file, lineStr, , level, code, message] = m;
    findings.push({
      filename: file,
      line: parseInt(lineStr, 10),
      severity: level as "error" | "warning",
      category: "Type Error",
      explanation: `${code}: ${message}`,
      source,
    });
  }
  return findings;
}

export function parseEslintJson(
  stdout: string,
  rootDir?: string,
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const data = tryParseJson<Array<{
    filePath: string;
    messages: Array<{
      line: number;
      severity: 1 | 2;
      ruleId: string | null;
      message: string;
    }>;
  }>>(stdout);
  if (!data) return findings;

  for (const result of data) {
    if (!result.messages?.length) continue;
    const filename = rootDir
      ? relative(rootDir, result.filePath).replace(/\\/g, "/")
      : result.filePath;
    for (const msg of result.messages) {
      if (!msg.line) continue;
      findings.push({
        filename,
        line: msg.line,
        severity: msg.severity === 2 ? "error" : "warning",
        category: "Lint",
        explanation: msg.ruleId ? `${msg.ruleId}: ${msg.message}` : msg.message,
        source: "eslint",
      });
    }
  }
  return findings;
}
