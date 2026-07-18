"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ArrowUp, CheckCircle2, Clock3, Loader2, RefreshCw, XCircle } from "lucide-react";
import { fetchJson } from "../../lib/http";

type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
type QueueJob = {
  jobId: string;
  state: JobState;
  queuePosition: number | null;
  triggerReason: string;
  repositoryName: string | null;
  prTitle: string | null;
  sourceBranch: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  priority: number;
};

const STATE_ORDER: JobState[] = ["queued", "running", "completed", "failed", "cancelled", "interrupted"];

export default function ScanQueueView() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchJson("/api/scan-queue");
      if (!res.ok) throw new Error("Queue request failed");
      const data = await res.json();
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (jobId: string, action: "cancel" | "retry" | "prioritize") => {
    setBusyJob(jobId);
    try {
      const res = await fetchJson("/api/scan-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, action }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Queue operation failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Queue operation failed.");
    } finally {
      setBusyJob(null);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl border border-white/10 bg-[#0F1219] p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">Scan queue</h3>
          <p className="text-xs text-slate-500 mt-1">Durable review jobs across all repositories.</p>
        </div>
        <button onClick={() => void load()} className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white" title="Refresh queue">
          <RefreshCw size={14} />
        </button>
      </div>
      {error && <div className="mb-3 rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</div>}
      {loading ? <div className="flex-1 grid place-items-center text-xs text-slate-500 font-mono">Loading queue...</div> : jobs.length === 0 ? (
        <div className="flex-1 grid place-items-center text-xs text-slate-600 font-mono">No scan jobs yet.</div>
      ) : (
        <div className="flex-1 overflow-auto space-y-2">
          {STATE_ORDER.map((state) => {
            const stateJobs = jobs.filter((job) => job.state === state);
            if (stateJobs.length === 0) return null;
            return (
              <section key={state}>
                <h4 className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mb-1">{state} ({stateJobs.length})</h4>
                {stateJobs.map((job) => <JobRow key={job.jobId} job={job} busy={busyJob === job.jobId} onAction={act} />)}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JobRow({ job, busy, onAction }: { job: QueueJob; busy: boolean; onAction: (id: string, action: "cancel" | "retry" | "prioritize") => void }) {
  const Icon = job.state === "completed" ? CheckCircle2 : job.state === "failed" ? XCircle : job.state === "running" ? Loader2 : job.state === "cancelled" ? AlertCircle : Clock3;
  return (
    <div className="rounded-lg border border-white/5 bg-slate-950/40 p-3 mb-2 flex flex-wrap items-center gap-3">
      <Icon size={14} className={job.state === "running" ? "text-cyan-400 animate-spin" : job.state === "failed" ? "text-rose-400" : job.state === "completed" ? "text-emerald-400" : "text-amber-400"} />
      <div className="min-w-[180px] flex-1">
        <div className="text-xs text-white font-semibold truncate">{job.prTitle || job.jobId}</div>
        <div className="text-[10px] text-slate-500 font-mono truncate">{job.repositoryName || "Unknown repository"} · {job.sourceBranch || "unknown branch"}</div>
      </div>
      <div className="text-[10px] text-slate-400 font-mono">{job.triggerReason}{job.queuePosition ? ` · #${job.queuePosition}` : ""}</div>
      <div className="text-[10px] text-slate-600 font-mono">created {formatTime(job.createdAt)}{job.completedAt ? ` · done ${formatTime(job.completedAt)}` : ""}</div>
      {job.errorMessage && <div className="w-full text-[10px] text-rose-300 truncate">{job.errorMessage}</div>}
      <div className="flex gap-1">
        {job.state === "queued" && <>
          <ActionButton label="Prioritize" icon={<ArrowUp size={11} />} disabled={busy} onClick={() => onAction(job.jobId, "prioritize")} />
          <ActionButton label="Cancel" disabled={busy} onClick={() => onAction(job.jobId, "cancel")} />
        </>}
        {job.state === "running" && <ActionButton label="Cancel" disabled={busy} onClick={() => onAction(job.jobId, "cancel")} />}
        {job.state === "failed" && <ActionButton label="Retry" disabled={busy} onClick={() => onAction(job.jobId, "retry")} />}
      </div>
    </div>
  );
}

function ActionButton({ label, icon, disabled, onClick }: { label: string; icon?: ReactNode; disabled: boolean; onClick: () => void }) {
  return <button onClick={onClick} disabled={disabled} className="px-2 py-1 rounded border border-white/10 text-[10px] text-slate-400 hover:text-white disabled:opacity-40 flex items-center gap-1">{icon}{label}</button>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
