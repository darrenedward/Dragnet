"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, Copy, Network, ShieldAlert } from "lucide-react";
import type { PullRequest, ReviewFinding } from "../../../lib/types";

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
};

interface Props {
  activePR: PullRequest | undefined;
  findings: ReviewFinding[];
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
}

function formatFindings(activePR: PullRequest | undefined, findings: ReviewFinding[]): string {
  const lines: string[] = [];
  lines.push(`# PR Review: ${activePR?.title || "Unknown"}`);
  lines.push(`**Branch:** ${activePR?.sourceBranch || "Unknown"}`);
  lines.push(`**Rating:** ${activePR?.rating ?? "N/A"}`);
  lines.push(`**Findings:** ${findings.length} total`);
  lines.push("");

  for (const sev of severityOrder) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    lines.push(`## ${sev.toUpperCase()} (${group.length})`);
    lines.push("");

    for (const f of group) {
      lines.push(`### ${f.filename}:${f.line}`);
      lines.push(`**Category:** ${f.category}`);
      if (f.confidence !== undefined && f.confidence !== null) {
        lines.push(`**Confidence:** ${(f.confidence * 100).toFixed(0)}%`);
      }
      lines.push("");
      lines.push(f.explanation);
      lines.push("");

      if (f.evidenceChain) {
        lines.push("**Evidence Chain:**");
        try {
          const chain = JSON.parse(f.evidenceChain);
          if (Array.isArray(chain)) {
            for (const point of chain) {
              lines.push(`- ${point.file}:${point.line} — ${point.text}`);
            }
          }
        } catch {
          lines.push(`- ${f.evidenceChain}`);
        }
        lines.push("");
      }

      if (f.diffSuggestion) {
        lines.push("```diff");
        lines.push(f.diffSuggestion);
        lines.push("```");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
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

export default function ReviewCard({ activePR, findings, onCopySuggestion, copyFeedback }: Props) {
  const [copiedAll, setCopiedAll] = useState(false);
  const handleCopyAll = useCallback(() => {
    const text = formatFindings(activePR, findings);
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  }, [activePR, findings]);

  return (
    <div className="bg-[#0F1219] border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-950/50 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className="text-rose-400" />
          <span className="text-xs uppercase font-mono tracking-wider font-extrabold text-slate-400">
            AI Core Code Audit Findings ({findings.length})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {activePR?.rating !== undefined && activePR?.rating !== null && (
            <span
              className={`px-2 py-0.5 rounded uppercase font-mono text-[9px] font-bold border ${
                activePR.rating >= 9
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}
            >
              {activePR.rating}/10
            </span>
          )}
          {findings.length > 0 && (
            <button
              onClick={handleCopyAll}
              className="px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[10px] font-mono font-bold text-slate-400 hover:text-white transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <Copy size={12} />
              <span>{copiedAll ? "Copied!" : "Copy All"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {findings.length === 0 ? (
        <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center">
          <CheckCircle2 size={24} className="text-emerald-400 mb-1.5" />
          <p className="text-xs font-bold text-slate-300 font-mono">Status: Ready for review scan</p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
            Click "Trigger AI Review Scan" to run real-time static checking.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {severityOrder.map((sev) => {
            const group = findings.filter((f) => f.severity === sev);
            if (group.length === 0) return null;
            const cfg = severityConfig[sev];

            return (
              <div key={sev} className={`border-l-2 ${cfg.border}`}>
                {/* Severity group header */}
                <div className="px-4 py-2 bg-white/[0.02] flex items-center gap-2 border-b border-white/5">
                  <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
                  <span className="text-[10px] font-mono font-extrabold uppercase tracking-wider text-slate-400">
                    {cfg.label}
                  </span>
                  <span className="text-[10px] font-mono text-slate-600">({group.length})</span>
                </div>

                {/* Findings in this group */}
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
                            <span className="text-xs font-semibold text-white tracking-tight">{finding.filename}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {finding.confidence !== undefined && finding.confidence !== null && (
                              <span className="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
                                {(finding.confidence * 100).toFixed(0)}%
                              </span>
                            )}
                            <span className="text-[10px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
                              Line {finding.line}
                            </span>
                          </div>
                        </div>

                        <p className="text-xs text-slate-300 leading-relaxed font-sans">{finding.explanation}</p>

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
                                  <span className="text-slate-400">
                                    <strong className="text-slate-300">{point.file}</strong> (Line {point.line}): {point.text}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {finding.diffSuggestion && (
                          <div className="mt-2 relative">
                            <div className="bg-black/50 rounded-lg p-3 font-mono text-xs text-slate-300 border border-white/5 overflow-y-auto max-h-40 whitespace-pre">
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
      )}
    </div>
  );
}
