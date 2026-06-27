"use client";

import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import PrSizeProfileChip from "../../PrSizeProfileChip";
import type { PrSizeProfile } from "../../../lib/prSizeProfile";
import type { ReviewChunk } from "../../../lib/types";

interface Props {
  reviewRun: {
    id: string;
    reliability?: string | null;
    chunksTotal?: number;
    chunksCompleted?: number;
    chunksFailed?: number;
    chunksSkipped?: number;
  };
  chunks: ReviewChunk[];
  sizeProfile?: PrSizeProfile;
  isRetrying?: boolean;
  onRetryFailedChunks?: () => void;
  /**
   * Per-chunk agentic-loop progress: {current, max} keyed by chunkId.
   * Only populated for active scans — completed runs don't need this
   * because every chunk is done. Lets the grid show "iter N/M" next to
   * running chunks so users can see the loop making progress.
   */
  iterationsByChunk?: Record<string, { current: number; max: number }>;
}

export default function LargePrModePanel({
  reviewRun,
  chunks,
  sizeProfile,
  isRetrying,
  onRetryFailedChunks,
  iterationsByChunk,
}: Props) {
  const failedCount = reviewRun.chunksFailed ?? chunks.filter((chunk) => chunk.status === "failed").length;
  const reliability = reviewRun.reliability || "pending";
  const cfg = reliabilityConfig(reliability);
  const ReliabilityIcon = cfg.Icon;

  return (
    <div className="border-b border-white/10 bg-slate-950/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider font-extrabold text-cyan-300">
              Large PR Mode
            </span>
            {sizeProfile && <PrSizeProfileChip profile={sizeProfile} />}
            <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[9px] font-mono font-bold uppercase ${cfg.className}`}>
              <ReliabilityIcon size={10} />
              {cfg.label}
            </span>
          </div>
          <div className="mt-1 text-[10px] font-mono text-slate-500">
            {(reviewRun.chunksCompleted ?? 0)}/{reviewRun.chunksTotal ?? chunks.length} chunks completed
            {(reviewRun.chunksFailed ?? 0) > 0 ? ` · ${reviewRun.chunksFailed} failed` : ""}
            {(reviewRun.chunksSkipped ?? 0) > 0 ? ` · ${reviewRun.chunksSkipped} skipped` : ""}
          </div>
          <div className="mt-1 text-[10px] font-mono text-amber-300/80">
            Cross-chunk bugs may be missed in v1; split recommended for oversized PRs.
          </div>
        </div>

        {failedCount > 0 && onRetryFailedChunks && (
          <button
            type="button"
            disabled={isRetrying}
            onClick={onRetryFailedChunks}
            className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 rounded text-[10px] font-mono font-bold text-amber-300 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {isRetrying ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            <span>{isRetrying ? "Retrying" : "Retry Failed"}</span>
          </button>
        )}
      </div>

      {chunks.length > 0 && (
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-1.5">
          {chunks.map((chunk) => {
            const status = statusConfig(chunk.status);
            const StatusIcon = status.Icon;
            const iter = iterationsByChunk?.[chunk.id];
            const showIter = chunk.status === "running" || chunk.status === "pending";
            return (
              <div key={chunk.id} className="border border-white/5 rounded bg-slate-950/50 px-2 py-1.5 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <StatusIcon size={11} className={status.iconClass} />
                    <span className="text-[10px] font-mono text-slate-300 truncate" title={chunk.filePaths.join("\n")}>
                      {chunk.label}
                    </span>
                    {chunk.touchesSecuritySensitive && (
                      <ShieldAlert size={10} className="text-rose-400 shrink-0" />
                    )}
                  </div>
                  <span className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ${status.className}`}>
                    {chunk.status}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] font-mono text-slate-600">
                  <span>{chunk.lineCount.toLocaleString()} lines · {chunk.filePaths.length} files</span>
                  <div className="flex items-center gap-2">
                    {showIter && iter && (
                      <span className="text-cyan-400" title="Agentic loop iteration">
                        iter {iter.current}/{iter.max}
                      </span>
                    )}
                    {chunk.rating !== null && chunk.rating !== undefined && (
                      <span className="text-slate-400">{chunk.rating}/10</span>
                    )}
                  </div>
                </div>
                {(chunk.errorMessage || chunk.skipReason) && (
                  <div className="mt-1 text-[9px] font-mono text-rose-300/80 truncate" title={chunk.errorMessage || chunk.skipReason || ""}>
                    {chunk.errorMessage || chunk.skipReason}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function reliabilityConfig(value: string): { label: string; className: string; Icon: typeof CheckCircle2 } {
  if (value === "complete") {
    return { label: "complete", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25", Icon: CheckCircle2 };
  }
  if (value === "incomplete_security_review") {
    return { label: "security incomplete", className: "bg-rose-500/10 text-rose-300 border-rose-500/25", Icon: ShieldAlert };
  }
  if (value === "partial") {
    return { label: "partial", className: "bg-amber-500/10 text-amber-400 border-amber-500/25", Icon: AlertTriangle };
  }
  return { label: "running", className: "bg-blue-500/10 text-blue-400 border-blue-500/25", Icon: Loader2 };
}

function statusConfig(value: string): { className: string; iconClass: string; Icon: typeof CheckCircle2 } {
  if (value === "completed") return { className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25", iconClass: "text-emerald-400", Icon: CheckCircle2 };
  if (value === "failed") return { className: "bg-rose-500/10 text-rose-300 border-rose-500/25", iconClass: "text-rose-400", Icon: XCircle };
  if (value === "skipped") return { className: "bg-amber-500/10 text-amber-400 border-amber-500/25", iconClass: "text-amber-400", Icon: AlertTriangle };
  if (value === "running") return { className: "bg-blue-500/10 text-blue-400 border-blue-500/25", iconClass: "text-blue-400 animate-spin", Icon: Loader2 };
  return { className: "bg-slate-700/40 text-slate-400 border-white/10", iconClass: "text-slate-500", Icon: Loader2 };
}
