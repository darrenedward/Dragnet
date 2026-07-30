"use client";

import { AlertTriangle, Check, X, Zap } from "lucide-react";
import type { ProtoPr, ProtoRepo } from "./mockData";

export function pill(className: string, children: React.ReactNode, title?: string) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 rounded uppercase font-mono text-[9px] font-bold border ${className}`}
    >
      {children}
    </span>
  );
}

export function PrIdentity({ pr }: { pr: ProtoPr }) {
  return (
    <div className="space-y-1 min-w-0">
      <h3 className="text-base sm:text-lg font-bold text-white tracking-tight leading-snug">
        {pr.title}
        {pr.ticketNumber != null && (
          <span className="text-cyan-400/90 font-mono font-semibold">
            {" "}
            — issue #{pr.ticketNumber}
          </span>
        )}
      </h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-slate-500">
        <span className="text-cyan-400/90 font-semibold">GitHub PR #{pr.githubPrNumber}</span>
        {pr.ticketNumber != null && pr.ticketNumber !== pr.githubPrNumber && (
          <span title="Issue tracker ticket number is not the same as the GitHub PR number">
            Ticket #{pr.ticketNumber} ≠ PR #{pr.githubPrNumber}
          </span>
        )}
        <span className="truncate text-slate-600 max-w-[180px]">{pr.branch}</span>
      </div>
    </div>
  );
}

/** Repo health strip — MAIN content only, not sidebar. */
export function RepoHealthStrip({ repo }: { repo: ProtoRepo }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0F1219] px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
      <div className="min-w-0">
        <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Active project</p>
        <p className="text-sm font-bold font-mono text-white truncate">{repo.name}</p>
      </div>
      <div className="h-8 w-px bg-white/10 hidden sm:block" />
      <HealthLine
        ok={repo.cloneOk}
        label="Cloned"
        failDetail={repo.cloneError}
        okTitle="Checkout ready for scans"
      />
      <HealthLine
        ok={repo.indexOk}
        label="Indexed"
        okTitle="AST index present"
        failDetail="Index missing — run Index now"
      />
      <HealthLine
        ok={repo.webhookConnected}
        label="Webhook"
        okTitle="GitHub notifies Dragnet on push/PR (installed + processing on)"
        failDetail="Off — no automatic GitHub → Dragnet events"
        mutedFail
      />
    </div>
  );
}

function HealthLine({
  ok,
  label,
  okTitle,
  failDetail,
  mutedFail,
}: {
  ok: boolean;
  label: string;
  okTitle: string;
  failDetail?: string | null;
  mutedFail?: boolean;
}) {
  const failColor = mutedFail ? "text-slate-500" : "text-rose-400";
  return (
    <div className="font-mono text-[11px]" title={ok ? okTitle : failDetail ?? undefined}>
      <div className="flex items-center gap-1.5">
        {ok ? (
          <Check size={14} className="text-emerald-400 shrink-0" />
        ) : (
          <X size={14} className={`${failColor} shrink-0`} strokeWidth={2.5} />
        )}
        <span className="text-slate-400">{label}</span>
        <span className={`font-bold ${ok ? "text-emerald-400" : failColor}`}>
          {ok ? "OK" : mutedFail ? "OFF" : "FAIL"}
        </span>
      </div>
      {!ok && failDetail && !mutedFail && (
        <p className="text-[9px] text-rose-400/80 mt-0.5 max-w-[220px] leading-snug pl-5">
          {failDetail}
        </p>
      )}
    </div>
  );
}

export function MergeChip({ pr }: { pr: ProtoPr }) {
  if (pr.mergeReady && pr.rating != null) {
    return pill(
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
      `${pr.rating}/10 · Merge ready`,
    );
  }
  if (pr.rating != null) {
    return pill(
      "bg-amber-500/10 text-amber-300 border-amber-500/25",
      `${pr.rating}/10 · Not ready`,
      pr.mergeReason ?? undefined,
    );
  }
  return pill(
    "bg-amber-500/10 text-amber-300 border-amber-500/25",
    "Not ready · no score",
    pr.mergeReason ??
      "Finished without a trusted score (e.g. findings rejected after a clean LLM pass)",
  );
}

export function Actions({ disabled }: { disabled?: boolean }) {
  return (
    <div className="flex gap-2 shrink-0">
      <button
        type="button"
        disabled={disabled}
        className={`min-h-10 px-4 py-2 text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-md ${
          disabled
            ? "bg-slate-700 text-slate-500 cursor-not-allowed"
            : "bg-gradient-to-r from-cyan-500 to-indigo-500 text-black"
        }`}
      >
        <Zap size={14} className={disabled ? "" : "fill-black"} />
        Run PR Review
      </button>
      <button
        type="button"
        disabled={disabled}
        className={`min-h-10 px-3 py-2 text-xs font-mono font-bold rounded-lg flex items-center gap-1.5 border ${
          disabled
            ? "bg-slate-800/50 border-slate-700 text-slate-600 cursor-not-allowed"
            : "bg-rose-500/15 border-rose-500/30 text-rose-300"
        }`}
      >
        <AlertTriangle size={13} />
        Force re-scan
      </button>
    </div>
  );
}

export function LogPanel({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0E14] overflow-hidden">
      <div className="px-3 py-2 border-b border-white/5 text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider">
        Scan logs
      </div>
      <div className="p-3 font-mono text-[11px] space-y-1 max-h-36 overflow-y-auto">
        {lines.map((l, i) => (
          <div key={i} className="text-cyan-500/80">
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
