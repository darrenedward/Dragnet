/**
 * Compact read-only rendering of a single ReviewFinding for the ScanHistory
 * expansion. Intentionally simpler than ReviewCard — no copy/diff actions,
 * no agentic feedback — just enough to read what the historical scan found.
 *
 * Shared between visible findings (white text) and rejected findings
 * (amber tint + verification note).
 */

interface HistoryFinding {
  id: string;
  filename: string;
  line: number | null;
  severity: string;
  category: string;
  explanation: string;
  verificationNote?: string | null;
  verificationStatus?: string | null;
  source?: string | null;
  confidence?: number | null;
  confidenceReason?: string | null;
  exploitability?: string | null;
  impact?: string | null;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  high: "bg-rose-500/10 text-rose-400 border-rose-500/25",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/25",
  low: "bg-sky-500/10 text-sky-400 border-sky-500/25",
  info: "bg-slate-700/40 text-slate-400 border-white/10",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/25",
  suggestion: "bg-sky-500/10 text-sky-400 border-sky-500/25",
};

function severityClass(sev: string): string {
  return SEVERITY_STYLE[sev?.toLowerCase()] ?? "bg-slate-700/40 text-slate-400 border-white/10";
}

function sourceChipClass(source: string): string {
  if (source === "tsc") return "bg-blue-500/10 text-blue-400 border-blue-500/25";
  if (source === "eslint") return "bg-purple-500/10 text-purple-400 border-purple-500/25";
  return "bg-slate-700/40 text-slate-400 border-white/10";
}

export default function HistoryFindingRow({ finding, rejected = false }: { finding: HistoryFinding; rejected?: boolean }) {
  return (
    <div
      className={`px-3 py-2 border-b border-white/5 last:border-b-0 ${
        rejected ? "bg-amber-500/[0.03]" : "hover:bg-white/[0.02]"
      } transition-colors`}
    >
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border font-bold ${severityClass(finding.severity)}`}>
          {finding.severity}
        </span>
        <span className="text-[10px] font-mono text-cyan-400/90 bg-cyan-400/5 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
          {finding.category}
        </span>
        {finding.exploitability && (
          <span
            title={`Exploitability: ${finding.exploitability}`}
            className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold border ${
              finding.exploitability === "trivial"
                ? "bg-rose-500/10 text-rose-400 border-rose-500/25"
                : finding.exploitability === "moderate"
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/25"
                  : "bg-slate-700/40 text-slate-400 border-white/10"
            }`}
          >
            {finding.exploitability}
          </span>
        )}
        {finding.impact && (
          <span
            title={`Impact: ${finding.impact}`}
            className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold border ${
              finding.impact === "critical" || finding.impact === "high"
                ? "bg-orange-500/10 text-orange-400 border-orange-500/25"
                : finding.impact === "medium"
                  ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/25"
                  : "bg-slate-700/40 text-slate-400 border-white/10"
            }`}
          >
            {finding.impact}
          </span>
        )}
        {finding.source && finding.source !== "llm" && (
          <span
            title={`Found by ${finding.source} (deterministic check)`}
            className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold border ${sourceChipClass(finding.source)}`}
          >
            {finding.source}
          </span>
        )}
        {finding.verificationStatus === "downgraded" && (
          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/25 font-bold">
            ↓ downgraded
          </span>
        )}
        {finding.verificationStatus === "unverified" && (
          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 border border-white/10 font-bold">
            ? unverified
          </span>
        )}
        {rejected && (
          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold">
            ✗ rejected
          </span>
        )}
        {finding.confidence !== null && finding.confidence !== undefined && (
          <span
            className="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5 ml-auto"
            title={finding.confidenceReason ?? undefined}
          >
            {(finding.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="text-[11px] font-mono text-slate-300 mb-0.5">
        {finding.filename}
        {finding.line !== null && finding.line > 0 && (
          <span className="text-slate-600">:{finding.line}</span>
        )}
      </div>
      <div className="text-[11px] text-slate-400 leading-relaxed break-words">
        {finding.explanation}
      </div>
      {rejected && finding.verificationNote && (
        <div className="mt-1.5 text-[10px] font-mono text-amber-400/80 italic border-l-2 border-amber-500/30 pl-2">
          {finding.verificationNote}
        </div>
      )}
    </div>
  );
}
