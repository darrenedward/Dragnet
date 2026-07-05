import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getScanStatePath, getLegacyScanStatePath } from "@/src/lib/scanStatePath";

/**
 * Per-scan report writer. Called from logRun() in orchestrator.ts as a
 * best-effort mirror of the DB row — same payload, also appended to disk
 * under the scan-state path so the /dragnet report skill command can read
 * it later.
 *
 * **Layout (centralised):** `<scanStateRoot>/<repoId>/reports/<runId>.md`
 * **Layout (legacy):** `<repoPath>/.dragnet/reports/<runId>.md`
 *
 * Slice 2: `appendReport` accepts an optional `repoId` parameter. When
 * provided, the central scan-state path is used. When omitted, the
 * legacy per-repo `.dragnet/` path is used for back-compat.
 *
 * File extension is `.md` for consistency with reviews/*.md artifacts.
 * Content is plain text — one line per log entry — but the `.md`
 * extension means editors render it as markdown, which is harmless
 * since plain text is valid markdown.
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
 * Best-effort append to the scan-state reports file.
 *
 * Accepts an optional `repoId`. When provided, the central scan-state
 * path is used (`<root>/<repoId>/reports/<runId>.md`). When omitted,
 * the legacy `<repoPath>/.dragnet/reports/<runId>.md` path is used.
 *
 * - Returns silently when no path is available.
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
  repoId?: string,
): Promise<void> {
  if (!runId) return;
  let dir: string;
  if (repoId) {
    dir = join(getScanStatePath(repoId), "reports");
  } else if (repoPath) {
    dir = join(repoPath, REPORTS_DIR_NAME);
  } else {
    return;
  }
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${runId}.md`), `${line}\n`, { encoding: "utf8" });
  } catch {
    // best-effort — see jsdoc
  }
}
