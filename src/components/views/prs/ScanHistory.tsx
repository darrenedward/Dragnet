"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";

interface ReviewRunSummary {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  rating: number | null;
  model: string | null;
  triggerReason: string | null;
  commitHash: string;
  forced: boolean;
}

interface LogEntry {
  id: string;
  message: string;
  level: string;
  createdAt: string;
}

interface Props {
  prId?: string;
  currentRunId?: string | null;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ratingChip(rating: number | null): { label: string; className: string } {
  if (rating === null || rating === undefined) {
    return {
      label: "unreliable",
      className: "bg-amber-500/10 text-amber-400 border-amber-500/25",
    };
  }
  if (rating >= 9) {
    return {
      label: `${rating}/10`,
      className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
    };
  }
  return {
    label: `${rating}/10`,
    className: "bg-rose-500/10 text-rose-400 border-rose-500/25",
  };
}

function statusChip(status: string): string {
  switch (status) {
    case "in_progress":
      return "bg-blue-500/10 text-blue-400 border-blue-500/25";
    case "completed":
      return "bg-slate-700/40 text-slate-300 border-white/10";
    case "failed":
      return "bg-rose-500/10 text-rose-400 border-rose-500/25";
    default:
      return "bg-slate-700/40 text-slate-400 border-white/10";
  }
}

export default function ScanHistory({ prId, currentRunId }: Props) {
  const [runs, setRuns] = useState<ReviewRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runLogs, setRunLogs] = useState<Record<string, LogEntry[]>>({});
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    if (!prId) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    const fetchRuns = async () => {
      try {
        const res = await fetch(`/api/prs/${prId}/runs`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setRuns(data.runs ?? []);
        }
      } catch {
        // ignore — will retry on next prId change
      }
    };
    fetchRuns();
    return () => {
      cancelled = true;
    };
  }, [prId]);

  const toggleRunLogs = async (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    if (runLogs[runId]) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/reviews/log?reviewRunId=${runId}`);
      if (res.ok) {
        const logs: LogEntry[] = await res.json();
        setRunLogs((prev) => ({ ...prev, [runId]: logs }));
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  if (!prId) return null;

  return (
    <div className="bg-[#0F1219] border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-white/[0.02] transition-colors cursor-pointer"
      >
        <span className="text-[10px] font-mono font-extrabold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
          <History size={11} className="text-slate-500" />
          Scan History ({runs.length})
        </span>
        <span className="text-slate-600 text-xs">{panelOpen ? "▲" : "▼"}</span>
      </button>

      {panelOpen && (
        <div className="px-2 pb-3 space-y-1 max-h-72 overflow-y-auto">
          {runs.length === 0 ? (
            <div className="text-[10px] text-slate-600 font-mono py-3 text-center italic">
              No prior scans on this PR.
            </div>
          ) : (
            runs.map((run) => {
              const isCurrent = run.id === currentRunId;
              const isOpen = expandedRunId === run.id;
              const rating = ratingChip(run.rating);
              return (
                <div key={run.id} className="border border-white/5 rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleRunLogs(run.id)}
                    className="w-full px-3 py-2 flex items-center gap-2 hover:bg-white/[0.02] transition-colors cursor-pointer text-left"
                  >
                    {isOpen ? (
                      <ChevronDown size={11} className="text-slate-500 shrink-0" />
                    ) : (
                      <ChevronRight size={11} className="text-slate-500 shrink-0" />
                    )}
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">
                      {formatTime(run.startedAt)}
                    </span>
                    <span className="text-[10px] font-mono text-cyan-400 bg-cyan-400/5 px-1.5 py-0.5 rounded shrink-0">
                      {(run.model || "?").slice(0, 14)}
                    </span>
                    <span
                      className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ${rating.className}`}
                    >
                      {rating.label}
                    </span>
                    <span
                      className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border shrink-0 ${statusChip(run.status)}`}
                    >
                      {run.status}
                    </span>
                    {run.triggerReason && (
                      <span className="text-[9px] font-mono uppercase text-slate-500 shrink-0">
                        · {run.triggerReason}
                      </span>
                    )}
                    {run.forced && (
                      <span className="text-[9px] font-mono uppercase text-amber-400/80 shrink-0">· forced</span>
                    )}
                    {isCurrent && (
                      <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0 ml-auto">
                        current
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="border-t border-white/5 bg-slate-950/40 p-2 max-h-48 overflow-y-auto">
                      {loading ? (
                        <div className="text-[10px] text-slate-600 font-mono py-2 flex items-center gap-1.5">
                          <Loader2 size={10} className="animate-spin" /> loading logs…
                        </div>
                      ) : (runLogs[run.id]?.length ?? 0) === 0 ? (
                        <div className="text-[10px] text-slate-600 font-mono py-2 italic">No logs for this run.</div>
                      ) : (
                        (runLogs[run.id] ?? []).map((log) => (
                          <div
                            key={log.id}
                            className="text-[10px] font-mono leading-relaxed py-0.5 px-1 text-slate-400 hover:bg-white/[0.02] rounded"
                          >
                            <span className="text-slate-600">{new Date(log.createdAt).toLocaleTimeString()}</span>{" "}
                            <span className="text-slate-500">·</span> {log.message}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
