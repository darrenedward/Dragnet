"use client";

import { Network } from "lucide-react";
import type { ReviewFinding } from "../../../lib/types";

const severityOrder = ["blocker", "warning", "suggestion"] as const;

const severityConfig = {
  blocker: {
    label: "Blockers",
    border: "border-rose-500/20",
    badge: "bg-rose-500/15 text-rose-400 border-rose-500/25",
    dot: "bg-rose-500",
  },
  warning: {
    label: "Warnings",
    border: "border-amber-500/20",
    badge: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    dot: "bg-amber-500",
  },
  suggestion: {
    label: "Suggestions",
    border: "border-white/10",
    badge: "bg-slate-800 text-slate-400 border-slate-750",
    dot: "bg-slate-500",
  },
} as const;

interface Props {
  findings: ReviewFinding[];
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
  /** Decorative chip rendered in the header row (e.g. "5 found so far"). */
  headerChip?: React.ReactNode;
  /** Visual smoothing for partial/live results — slightly mutes the rows. */
  variant?: "complete" | "partial";
}

function parseEvidence(chain: ReviewFinding["evidenceChain"]): Array<{ file: string; line: number; text: string }> {
  if (!chain) return [];
  try {
    const parsed = typeof chain === "string" ? JSON.parse(chain) : chain;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Severity-grouped findings list. Rendered for both completed scans (full
 * findings) and live scans (partial findings from completed chunks). The
 * `variant="partial"` mode mutes the rows slightly to signal "still
 * scanning — more may follow".
 */
export default function FindingsList({ findings, onCopySuggestion, copyFeedback, headerChip, variant = "complete" }: Props) {
  const rowOpacity = variant === "partial" ? "opacity-95" : "";
  return (
    <div className={`divide-y divide-white/5 ${rowOpacity}`}>
      {headerChip && (
        <div className="px-4 py-2 bg-cyan-950/20 border-b border-cyan-500/15 flex items-center gap-2">
          {headerChip}
        </div>
      )}
      {severityOrder.map((sev) => {
        const group = findings.filter((f) => f.severity === sev);
        if (group.length === 0) return null;
        const cfg = severityConfig[sev];

        return (
          <div key={sev} className={`border-l-2 ${cfg.border}`}>
            <div className="px-4 py-2 bg-white/[0.02] flex items-center gap-2 border-b border-white/5">
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              <span className="text-[10px] font-mono font-extrabold uppercase tracking-wider text-slate-400">
                {cfg.label}
              </span>
              <span className="text-[10px] font-mono text-slate-600">({group.length})</span>
            </div>

            <div className="divide-y divide-white/5">
              {group.map((finding) => {
                const evidencePoints = parseEvidence(finding.evidenceChain);
                return (
                  <div key={finding.id} className="px-4 py-3 hover:bg-white/[0.01] transition-colors">
                    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase font-mono border ${cfg.badge}`}>
                          {finding.severity}
                        </span>
                        <span className="text-[10px] font-mono text-cyan-400 bg-cyan-400/5 px-1.5 rounded font-bold uppercase tracking-wider">
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
                            title={`Found by ${finding.source} (deterministic check) — not the LLM`}
                            className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold border ${
                              finding.source === "tsc"
                                ? "bg-blue-500/10 text-blue-400 border-blue-500/25"
                                : "bg-purple-500/10 text-purple-400 border-purple-500/25"
                            }`}
                          >
                            {finding.source}
                          </span>
                        )}
                        <span className="text-xs font-semibold text-white tracking-tight">{finding.filename}</span>
                        {finding.verificationStatus === "downgraded" && (
                          <span
                            title={finding.verificationNote || "Real issue but overstated"}
                            className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/25 font-bold"
                          >
                            ↓ Downgraded
                          </span>
                        )}
                        {finding.verificationStatus === "unverified" && (
                          <span
                            title={finding.verificationNote || "Verifier couldn't reach a verdict"}
                            className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 border border-white/10 font-bold"
                          >
                            ? Unverified
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {finding.confidence !== undefined && finding.confidence !== null && (
                          <span
                            className="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5"
                            title={finding.confidenceReason ?? undefined}
                          >
                            {(finding.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
                          Line {finding.line}
                        </span>
                      </div>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed font-sans break-words whitespace-pre-wrap">{finding.explanation}</p>

                    {evidencePoints.length > 0 && (
                      <div className="mt-2 text-xs font-mono bg-slate-950/50 p-2.5 rounded-lg border border-white/5 space-y-1.5">
                        <div className="text-[10px] text-cyan-400 uppercase font-bold flex items-center gap-1.5 border-b border-white/5 pb-1 select-none">
                          <Network size={11} className="text-cyan-400" />
                          <span>Evidence Chain</span>
                        </div>
                        <div className="space-y-1 pl-1 border-l border-cyan-500/20 ml-1">
                          {evidencePoints.map((point, pIdx) => (
                            <div key={pIdx} className="text-[11px] leading-relaxed flex items-start gap-1.5">
                              <span className="text-cyan-500 font-extrabold select-none shrink-0">[{pIdx + 1}]</span>
                              <span className="text-slate-400 break-words">
                                <strong className="text-slate-300 break-all">{point.file}</strong> (Line {point.line}): {point.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {finding.diffSuggestion && (
                      <div className="mt-2 relative">
                        <div className="bg-black/50 rounded-lg p-3 font-mono text-xs text-slate-300 border border-white/5 overflow-y-auto max-h-40 whitespace-pre-wrap break-words">
                          <div className="text-slate-600 text-[10px] font-semibold border-b border-white/5 pb-1 mb-2 uppercase tracking-wide flex items-center justify-between">
                            <span>Suggested Fix</span>
                            <button
                              onClick={() => onCopySuggestion(finding.diffSuggestion, finding.id)}
                              className="hover:text-white transition-colors cursor-pointer"
                            >
                              {copyFeedback === finding.id ? "Copied!" : "Copy"}
                            </button>
                          </div>
                          <div className="text-[11px] font-mono leading-relaxed text-slate-300">{finding.diffSuggestion}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
