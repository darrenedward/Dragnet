"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Network, ShieldAlert } from "lucide-react";
import type { PullRequest, ReviewChunk, ReviewFinding } from "../../../lib/types";
import PrSizeProfileChip from "../../PrSizeProfileChip";
import LargePrModePanel from "./LargePrModePanel";

export interface ReviewRunMeta {
  id: string;
  commitHash: string;
  diffHash: string;
  completedAt: string | null;
  rating: number | null;
  model: string | null;
  triggerReason: string | null;
  reliability?: string | null;
  chunksTotal?: number;
  chunksCompleted?: number;
  chunksFailed?: number;
  chunksSkipped?: number;
}

/**
 * Subset of ReviewRunMeta used to drive LargePrModePanel during a live
 * scan. Active in-progress runs don't have rating/completedAt/reliability
 * yet, so we only require the chunk-count fields (and the run id).
 */
export type ActiveScanMeta = Pick<ReviewRunMeta, "id" | "chunksTotal" | "chunksCompleted" | "chunksFailed" | "chunksSkipped" | "reliability">;

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
  reviewRun?: ReviewRunMeta | null;
  rejectedCount?: number;
  rejectedFindings?: Array<{
    id: string; filename: string; line: number | null;
    severity: string; category: string; explanation: string;
    verificationNote: string | null;
  }>;
  stale?: boolean;
  isScanning?: boolean;
  chunks?: ReviewChunk[];
  // Currently in-progress scan + its live chunks. When isScanning is true
  // and activeScan has chunks, LargePrModePanel renders from this instead
  // of the (possibly stale) completed reviewRun — so users see live chunk
  // progress instead of just a spinner.
  activeScan?: ActiveScanMeta | null;
  activeChunks?: ReviewChunk[];
  isRetryingChunks?: boolean;
  onRetryFailedChunks?: () => void;
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

export default function ReviewCard({ activePR, findings, reviewRun, rejectedCount, rejectedFindings, stale, isScanning, chunks = [], activeScan, activeChunks = [], isRetryingChunks, onRetryFailedChunks, onCopySuggestion, copyFeedback }: Props) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const handleCopyAll = useCallback(() => {
    const text = formatFindings(activePR, findings);
    try {
      navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  }, [activePR, findings]);

  return (
    <div className="bg-[#0F1219] border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-slate-950/50 border-b border-white/10 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {isScanning ? (
            <Loader2 size={14} className="text-cyan-400 animate-spin" />
          ) : (
            <ShieldAlert size={14} className="text-rose-400" />
          )}
          <span className="text-xs uppercase font-mono tracking-wider font-extrabold text-slate-400">
            {isScanning ? "AI Review In Progress" : `AI Core Code Audit Findings (${findings.length})`}
          </span>
          {reviewRun && !isScanning && (
            <span className="ml-2 text-[10px] font-mono text-slate-500 flex items-center gap-1.5">
              <span className="text-slate-400">Reviewed:</span>
              <code className="text-cyan-400 bg-cyan-400/5 px-1.5 py-0.5 rounded">
                {reviewRun.commitHash.slice(0, 7)}
              </code>
              {reviewRun.completedAt && (
                <span className="text-slate-600">
                  {formatRelativeTime(reviewRun.completedAt)}
                </span>
              )}
            </span>
          )}
          {stale && !isScanning && (
            <span
              title="The saved review no longer matches the current PR diff. Run the scan again to refresh it."
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/25 text-[9px] font-mono font-bold uppercase"
            >
              <AlertTriangle size={10} />
              <span>Review out of date</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {activePR?.rating !== undefined && activePR?.rating !== null && !isScanning && (
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
          {activePR?.sizeProfile && !isScanning && (
            <PrSizeProfileChip profile={activePR.sizeProfile} />
          )}
          {findings.length > 0 && !isScanning && (
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

      {/* Large PR Mode chunk panel.
          During a live scan, prefer the in-progress run (activeScan) over
          the latest completed reviewRun — the completed run's chunks are
          stale by definition (a new scan is running), and for first-time
          oversized scans there's no completed run at all. Falling back to
          activeScan here is what surfaces live chunk progress instead of
          just the spinner. */}
      {(() => {
        const activeHasChunks = isScanning && activeScan && (activeScan.chunksTotal ?? 0) > 0;
        const completedHasChunks = reviewRun && (reviewRun.chunksTotal ?? 0) > 0;
        if (activeHasChunks) {
          return (
            <LargePrModePanel
              reviewRun={activeScan}
              chunks={activeChunks}
              sizeProfile={activePR?.sizeProfile}
              isRetrying={isRetryingChunks}
              onRetryFailedChunks={onRetryFailedChunks}
            />
          );
        }
        if (completedHasChunks && !isScanning) {
          return (
            <LargePrModePanel
              reviewRun={reviewRun}
              chunks={chunks}
              sizeProfile={activePR?.sizeProfile}
              isRetrying={isRetryingChunks}
              onRetryFailedChunks={onRetryFailedChunks}
            />
          );
        }
        return null;
      })()}

      {/* Scanning state — previous findings have been moved to Scan History */}
      {isScanning ? (
        <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center">
          <Loader2 size={24} className="text-cyan-400 animate-spin mb-2" />
          <p className="text-xs font-bold text-cyan-300 font-mono">
            AI review pipeline running
          </p>
          <p className="text-[10px] text-slate-500 font-mono mt-1 max-w-md">
            {activeScan && (activeScan.chunksTotal ?? 0) > 0
              ? `Chunked scan in progress — ${activeScan.chunksCompleted ?? 0}/${activeScan.chunksTotal} complete. Watch chunk grid above for per-file status.`
              : reviewRun
                ? "Previous findings have moved to Scan History below — watch Review Progress for live iteration logs."
                : "Watch Review Progress above for live iteration logs."}
          </p>
        </div>
      ) : findings.length === 0 ? (
        <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center">
          {reviewRun && reviewRun.rating === null ? (
            <>
              <ShieldAlert size={24} className="text-amber-400 mb-1.5" />
              <p className="text-xs font-bold text-amber-300 font-mono">
                Rating unreliable — verifier rejected all findings
              </p>
              <p className="text-[10px] text-slate-500 font-mono mt-0.5 max-w-md">
                The LLM produced findings but none passed verification (cited files were missing, wrong, or documentation). Re-scan recommended — expand the rejected list below for details.
              </p>
            </>
          ) : (
            <>
              <CheckCircle2 size={24} className="text-emerald-400 mb-1.5" />
              <p className="text-xs font-bold text-slate-300 font-mono">
                {reviewRun ? "Review complete: no findings" : "Status: Ready for review scan"}
              </p>
              <p className="text-[10px] text-slate-600 font-mono mt-0.5">
                {reviewRun
                  ? "This scan did not find any active alerts for the current report."
                  : "Click \"Trigger AI Review Scan\" to run real-time static checking."}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="divide-y divide-white/5 max-h-[70vh] overflow-y-auto">
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
                              <span className="text-[9px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
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
      )}

      {(rejectedCount ?? 0) > 0 && !isScanning && (
        <div className="border-t border-white/5 bg-slate-950/30">
          <button
            onClick={() => setShowRejected((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
          >
            <span className="text-[10px] font-mono uppercase tracking-wider text-amber-400/80 flex items-center gap-1.5">
              <ShieldAlert size={11} className="text-amber-500" />
              Verifier rejected: {rejectedCount} finding{(rejectedCount ?? 0) === 1 ? "" : "s"}
              {reviewRun?.rating === null && (
                <span className="ml-2 text-rose-400 normal-case tracking-normal">
                  · rating nulled (all findings rejected)
                </span>
              )}
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {showRejected ? "▲ hide" : "▼ show"}
            </span>
          </button>
          {showRejected && (rejectedFindings?.length ?? 0) > 0 && (
            <div className="divide-y divide-white/5 border-t border-white/5">
              {rejectedFindings!.map((f) => (
                <div key={f.id} className="px-4 py-2.5 opacity-70">
                  <div className="flex items-center gap-2 text-[10px] font-mono mb-1">
                    <span className="line-through text-slate-500">{f.filename}:{f.line ?? "?"}</span>
                    <span className="text-[8px] uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/25 px-1 py-0.5 rounded">
                      rejected
                    </span>
                    <span className="text-[8px] uppercase tracking-wider text-slate-600">{f.severity}/{f.category}</span>
                  </div>
                  <div className="text-[10px] text-amber-300/70 italic font-mono mb-1">
                    {f.verificationNote || "no verifier note"}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono leading-relaxed">
                    {f.explanation.slice(0, 280)}{f.explanation.length > 280 ? "…" : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const sec = Math.max(1, Math.floor((now - then) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  } catch {
    return "";
  }
}
