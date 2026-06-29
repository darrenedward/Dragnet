import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-scan report writer. Called from logRun() in orchestrator.ts as a
 * best-effort mirror of the DB row — same payload, also appended to disk
 * under <repoPath>/.dragnet/reports/<runId>.md so the /dragnet report
 * skill command can read it later.
 *
 * Path resolution: repoPath is the SCANNED repo's absolute path (from
 * Repository.path via Prisma). NOT process.cwd() — that would land the
 * file in the Dragnet install dir, not the scanned project. See
 * `project_per_scan_artifacts_use_repo_path` memory.
 *
 * File extension is `.md` for consistency with `.dragnet/reviews/*.md`
 * (the findings-card artifact). Content is plain text — one line per
 * log entry — but the `.md` extension means editors render it as
 * markdown, which is harmless since plain text is valid markdown.
 */

export const REPORTS_DIR_NAME = ".dragnet/reports";

export interface ReportLineInput {
  message: string;
  level?: string;
  chunkId?: string | null;
  /** Injection point for tests. Defaults to new Date(). */
  now?: () => Date;
}

/**
 * Formats a single logRun entry as a line for the report file.
 *
 * Shape: `<ISO> [<level>] [<chunkId>] <message>`
 * - chunkId segment is omitted when null/undefined
 * - level defaults to "info" when missing
 * - trailing newline NOT included; caller (appendReport) adds it
 */
export function formatReportLine({
  message,
  level = "info",
  chunkId = null,
  now = () => new Date(),
}: ReportLineInput): string {
  const ts = now().toISOString();
  const chunkSegment = chunkId ? ` [${chunkId}]` : "";
  return `${ts} [${level}]${chunkSegment} ${message}`;
}

/**
 * Best-effort append to <repoPath>/.dragnet/reports/<runId>.md.
 *
 * - Returns silently when repoPath is empty (legacy callers / tests).
 * - Creates the directory if missing.
 * - Catches all fs errors and returns silently — disk logging must
 *   never break a scan. Caller (logRun) has already persisted to the
 *   DB; the disk mirror is a convenience for the skill, not a primary
 *   artifact.
 */
export async function appendReport(
  repoPath: string,
  runId: string,
  line: string,
): Promise<void> {
  if (!repoPath || !runId) return;
  try {
    const dir = join(repoPath, REPORTS_DIR_NAME);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${runId}.md`), `${line}\n`, { encoding: "utf8" });
  } catch {
    // best-effort — see jsdoc
  }
}
