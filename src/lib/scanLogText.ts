/** One scan-log line for clipboard formatting. */
export interface ScanLogLine {
  message: string;
  level?: string;
  createdAt?: string;
}

/**
 * Format scan log entries as plain text for clipboard copy.
 * One line per entry: optional timestamp, optional [level], then message.
 */
export function formatScanLogText(logs: ScanLogLine[]): string {
  return logs
    .map((log) => {
      const parts: string[] = [];
      if (log.createdAt) {
        parts.push(log.createdAt);
      }
      if (log.level) {
        parts.push(`[${log.level}]`);
      }
      parts.push(log.message);
      return parts.join(" ");
    })
    .join("\n");
}
