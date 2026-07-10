"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, ShieldAlert } from "lucide-react";
import type { PullRequest, ReviewChunk, ReviewFinding } from "../../../lib/types";
import type { StabilityProp } from "../../../lib/stabilityScore";
import PrSizeProfileChip from "../../PrSizeProfileChip";
import FindingsList from "./FindingsList";
import LargePrModePanel from "./LargePrModePanel";
import CostBanner from "./CostBanner";

export interface ReviewRunMeta {
  id: string;
  commitHash: string;
  diffHash: string;
  completedAt: string | null;
  rating: number | null;
  model: string | null;
  triggerReason: string | null;
  reliability?: string | null;
  refused?: boolean;
  refusalNote?: string | null;
  chunksTotal?: number;
  chunksCompleted?: number;
  chunksFailed?: number;
  chunksSkipped?: number;
  tokensUsed?: {
    totalCostUsd: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    providers: Array<{
      name: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      outcome: string;
      iterationsUsed: number;
      maxIterations: number;
    }>;
  } | null;
}

/**
 * Subset of ReviewRunMeta used to drive LargePrModePanel during a live
 * scan. Active in-progress runs don't have rating/completedAt/reliability
 * yet, so we only require the chunk-count fields (and the run id).
 */
export type ActiveScanMeta = Pick<ReviewRunMeta, "id" | "chunksTotal" | "chunksCompleted" | "chunksFailed" | "chunksSkipped" | "reliability">;

const severityOrder = ["blocker", "warning", "suggestion"] as const;

interface Props {
  activePR: PullRequest | undefined;
  findings: ReviewFinding[];
  reviewRun?: ReviewRunMeta | null;
  rejectedCount?: number;
  rejectedFindings?: Array<{
    id: string; filename: string; line: number | null;
    severity: string; category: string; explanation: string;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
  }>;
  stale?: boolean;
  stability?: StabilityProp | null;
  isScanning?: boolean;
  chunks?: ReviewChunk[];
  // Currently in-progress scan + its live chunks. When isScanning is true
  // and activeScan has chunks, LargePrModePanel renders from this instead
  // of the (possibly stale) completed reviewRun — so users see live chunk
  // progress instead of just a spinner.
  activeScan?: ActiveScanMeta | null;
  activeChunks?: ReviewChunk[];
  // Partial findings already persisted from completed chunks of the
  // active scan. Rendered in the same severity-grouped list as completed
  // findings, labeled "Found so far" — gives the user something to act
  // on while the rest of the scan finishes.
  activeFindings?: ReviewFinding[];
  // Per-chunk agentic-loop progress, keyed by chunkId. Lets the chunk
  // grid show "iter N/M" next to running chunks. Non-chunked scans use
  // the "__run" sentinel key.
  activeIterations?: Record<string, { current: number; max: number }>;
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
        const confidenceLine = `**Confidence:** ${(f.confidence * 100).toFixed(0)}%`;
        lines.push(f.confidenceReason ? `${confidenceLine} — ${f.confidenceReason}` : confidenceLine);
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

export default function ReviewCard({
  activePR,
  findings,
  reviewRun,
  rejectedCount,
  rejectedFindings,
  stale,
  stability,
  isScanning,
  chunks = [],
  activeScan,
  activeChunks = [],
  activeFindings = [],
  activeIterations,
  isRetryingChunks,
  onRetryFailedChunks,
  onCopySuggestion,
  copyFeedback,
}: Props) {
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
      {/* Header — hidden during active scan; ScanningBanner below already
          shows "AI review pipeline running" with iteration/chunk/findings
          detail, and every right-side chip in this bar is gated on
          !isScanning anyway, so rendering it would just be a 3-word title. */}
      {!isScanning && (
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
              {reviewRun && (
                <span className="ml-1">
                  <CostBanner tokensUsed={reviewRun.tokensUsed ?? null} />
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
                activePR.rating >= 8
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}
            >
              {activePR.rating}/10
            </span>
          )}
          {stability && !isScanning && (
            <span
              title={
                stability.readyToMerge
                  ? `${stability.consecutiveCleanRounds} consecutive clean rounds — ready to merge`
                  : stability.consecutiveCleanRounds > 0
                    ? `${stability.consecutiveCleanRounds} clean round${stability.consecutiveCleanRounds === 1 ? "" : "s"}, still fluctuating`
                    : "Not enough data for stability score"
              }
              className={`px-2 py-0.5 rounded uppercase font-mono text-[9px] font-bold border flex items-center gap-1 ${
                stability.readyToMerge
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/25"
              }`}
            >
              {stability.readyToMerge ? "✓" : "◐"} {stability.consecutiveCleanRounds}
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
      )}

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
              iterationsByChunk={activeIterations}
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

      {/* Scanning state — compact banner + partial findings from completed chunks. */}
      {isScanning ? (
        <>
          <ScanningBanner
            activeScan={activeScan ?? null}
            activeIterations={activeIterations}
            partialCount={activeFindings.length}
          />
          {activeFindings.length > 0 && (
            <FindingsList
              findings={activeFindings}
              variant="partial"
              onCopySuggestion={onCopySuggestion}
              copyFeedback={copyFeedback}
              headerChip={
                <span className="text-[10px] font-mono uppercase tracking-wider text-cyan-300 font-bold flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" />
                  Found so far — {activeFindings.length} finding{activeFindings.length === 1 ? "" : "s"} (scan still running)
                </span>
              }
            />
          )}
        </>
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
        <FindingsList
          findings={findings}
          onCopySuggestion={onCopySuggestion}
          copyFeedback={copyFeedback}
        />
      )}

      {reviewRun?.refused && !isScanning && (
        <div className="border-t border-amber-500/20 bg-amber-500/[0.03] px-4 py-2.5 flex items-start gap-2">
          <ShieldAlert size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-mono uppercase tracking-wider text-amber-400 font-bold">
              Reviewer flagged incomplete coverage
            </p>
            <p className="text-[10px] text-amber-300/80 font-mono mt-0.5 leading-relaxed">
              {reviewRun.refusalNote ?? "Parts of the PR were skipped or not fully analyzed."}
              <span className="text-amber-500/60"> Re-scan recommended after addressing the underlying cause.</span>
            </p>
          </div>
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
                    {f.skepticVerdict === "rejected" && (
                      <span className="text-[8px] uppercase tracking-wider bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/25 px-1 py-0.5 rounded">
                        skeptic
                      </span>
                    )}
                    <span className="text-[8px] uppercase tracking-wider text-slate-600">{f.severity}/{f.category}</span>
                  </div>
                  <div className="text-[10px] text-amber-300/70 italic font-mono mb-1">
                    {f.verificationNote || f.skepticNote || "no note"}
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

/**
 * Summarize iteration progress across an active scan.
 *
 * Chunked scans: take the max iteration across all per-chunk entries —
 * represents "the deepest round any chunk has reached". For non-chunked
 * scans (or when only the run-level sentinel exists), use that entry
 * directly.
 */
function pickIteration(
  activeScan: ActiveScanMeta | null,
  iterations: Record<string, { current: number; max: number }> | undefined,
): { current: number; max: number } | null {
  if (!iterations) return null;
  const chunked = activeScan && (activeScan.chunksTotal ?? 0) > 0;
  if (!chunked) {
    const run = iterations["__run"];
    return run ?? null;
  }
  let best: { current: number; max: number } | null = null;
  for (const key of Object.keys(iterations)) {
    if (key === "__run") continue;
    const v = iterations[key];
    if (!v) continue;
    if (!best || v.current > best.current) best = v;
  }
  return best;
}

/**
 * Compact banner shown above partial findings during a live scan. Tells
 * the user what's happening (chunks done, iteration N/M, partial count)
 * without forcing them to scroll the log panel.
 */
function ScanningBanner({
  activeScan,
  activeIterations,
  partialCount,
}: {
  activeScan: ActiveScanMeta | null;
  activeIterations?: Record<string, { current: number; max: number }>;
  partialCount: number;
}) {
  const iter = pickIteration(activeScan, activeIterations);
  const chunked = activeScan && (activeScan.chunksTotal ?? 0) > 0;
  const chunksText = chunked
    ? `${activeScan?.chunksCompleted ?? 0}/${activeScan?.chunksTotal ?? 0} chunks done`
    : null;
  const iterText = iter ? `iteration ${iter.current}/${iter.max}` : null;
  const partialText = partialCount > 0 ? `${partialCount} found so far` : null;
  const detail = [chunksText, iterText, partialText].filter(Boolean).join(" · ");

  return (
    <div className="p-3 bg-cyan-950/20 border-b border-cyan-500/15 flex items-center gap-2 flex-wrap">
      <Loader2 size={14} className="text-cyan-400 animate-spin shrink-0" />
      <span className="text-[11px] font-bold text-cyan-300 font-mono uppercase tracking-wider">
        AI review pipeline running
      </span>
      {detail && (
        <span className="text-[10px] font-mono text-slate-400">
          {detail}
        </span>
      )}
      <span className="ml-auto text-[10px] font-mono text-slate-500">
        Watch Review Progress for live iteration logs
      </span>
    </div>
  );
}
