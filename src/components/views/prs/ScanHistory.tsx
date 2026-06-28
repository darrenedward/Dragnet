"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2 } from "lucide-react";
import HistoryFindingRow from "./HistoryFindingRow";

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

interface RunFindings {
  findings: Array<{
    id: string;
    filename: string;
    line: number | null;
    severity: string;
    category: string;
    explanation: string;
    diffSuggestion: string | null;
    evidenceChain: string | null;
    confidence: number | null;
    verificationStatus: string | null;
    verificationNote: string | null;
    source: string | null;
    exploitability?: string | null;
    impact?: string | null;
  }>;
  rejectedFindings: Array<{
    id: string;
    filename: string;
    line: number | null;
    severity: string;
    category: string;
    explanation: string;
    verificationNote: string | null;
    source: string | null;
  }>;
  rejectedCount: number;
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
  const [runFindings, setRunFindings] = useState<Record<string, RunFindings>>({});
  const [loading, setLoading] = useState(false);
  const [showRejected, setShowRejected] = useState<Record<string, boolean>>({});
  const [panelOpen, setPanelOpen] = useState(false);

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

  // Hide in_progress runs — they're already shown live in ReviewProgress above.
  // A run appearing here means it has finished (completed or failed).
  const historicalRuns = runs.filter((r) => r.status !== "in_progress");

  const toggleRun = async (runId: string) => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    // Lazy-load both logs and findings on first expand.
    const needLogs = !runLogs[runId];
    const needFindings = !runFindings[runId];
    if (!needLogs && !needFindings) return;
    setLoading(true);
    try {
      const [logsRes, findingsRes] = await Promise.all([
        needLogs ? fetch(`/api/reviews/log?reviewRunId=${runId}`).then((r) => r.ok ? r.json() : []).catch(() => []) : Promise.resolve(null),
        needFindings ? fetch(`/api/reviews/run?reviewRunId=${runId}`).then((r) => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      ]);
      if (logsRes) {
        setRunLogs((prev) => ({ ...prev, [runId]: logsRes as LogEntry[] }));
      }
      if (findingsRes) {
        setRunFindings((prev) => ({ ...prev, [runId]: findingsRes as RunFindings }));
      }
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
          Scan History ({historicalRuns.length})
        </span>
        <span className="text-slate-600 text-xs">{panelOpen ? "▲" : "▼"}</span>
      </button>

      {panelOpen && (
        <div className="px-2 pb-3 space-y-1 max-h-[28rem] overflow-y-auto">
          {historicalRuns.length === 0 ? (
            <div className="text-[10px] text-slate-600 font-mono py-3 text-center italic">
              No prior scans on this PR.
            </div>
          ) : (
            historicalRuns.map((run) => {
              const isCurrent = run.id === currentRunId;
              const isOpen = expandedRunId === run.id;
              const rating = ratingChip(run.rating);
              const rf = runFindings[run.id];
              const findingCount = rf?.findings.length ?? 0;
              const rejectedCount = rf?.rejectedCount ?? 0;
              return (
                <div key={run.id} className="border border-white/5 rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleRun(run.id)}
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
                    {rf && findingCount > 0 && (
                      <span className="text-[9px] font-mono uppercase text-slate-500 shrink-0">
                        · {findingCount} finding{findingCount === 1 ? "" : "s"}
                      </span>
                    )}
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
                    <div className="border-t border-white/5 bg-slate-950/40">
                      {loading ? (
                        <div className="text-[10px] text-slate-600 font-mono py-3 flex items-center gap-1.5 justify-center">
                          <Loader2 size={11} className="animate-spin" /> loading scan details…
                        </div>
                      ) : (
                        <>
                          {/* Findings */}
                          {rf && rf.findings.length > 0 ? (
                            <div className="max-h-64 overflow-y-auto">
                              {rf.findings.map((f) => (
                                <HistoryFindingRow key={f.id} finding={f} />
                              ))}
                            </div>
                          ) : rf ? (
                            <div className="px-3 py-3 text-[10px] text-slate-600 font-mono italic text-center">
                              Scan completed with no findings (clean review).
                            </div>
                          ) : null}

                          {/* Rejected findings */}
                          {rf && rejectedCount > 0 && (
                            <div className="border-t border-amber-500/15">
                              <button
                                onClick={() =>
                                  setShowRejected((prev) => ({ ...prev, [run.id]: !prev[run.id] }))
                                }
                                className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-amber-500/[0.04] transition-colors cursor-pointer"
                              >
                                {showRejected[run.id] ? (
                                  <ChevronDown size={10} className="text-amber-400/70" />
                                ) : (
                                  <ChevronRight size={10} className="text-amber-400/70" />
                                )}
                                <span className="text-[9px] font-mono uppercase text-amber-400/80 font-bold tracking-wider">
                                  Verifier rejected: {rejectedCount}
                                </span>
                              </button>
                              {showRejected[run.id] && (
                                <div className="max-h-40 overflow-y-auto">
                                  {rf.rejectedFindings.map((f) => (
                                    <HistoryFindingRow key={f.id} finding={f} rejected />
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Logs */}
                          <div className="border-t border-white/5">
                            <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-wider text-slate-600 bg-white/[0.01]">
                              logs ({runLogs[run.id]?.length ?? 0})
                            </div>
                            <div className="max-h-32 overflow-y-auto">
                              {(runLogs[run.id]?.length ?? 0) === 0 ? (
                                <div className="text-[10px] text-slate-600 font-mono py-2 italic text-center">
                                  No logs for this run.
                                </div>
                              ) : (
                                (runLogs[run.id] ?? []).map((log) => (
                                  <div
                                    key={log.id}
                                    className="text-[10px] font-mono leading-relaxed py-0.5 px-3 text-slate-400 hover:bg-white/[0.02]"
                                  >
                                    <span className="text-slate-600">{new Date(log.createdAt).toLocaleTimeString()}</span>{" "}
                                    <span className="text-slate-600">·</span> {log.message}
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        </>
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
