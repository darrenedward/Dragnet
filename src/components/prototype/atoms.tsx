"use client";

import { AlertTriangle, Zap } from "lucide-react";
import type { ProtoPr, ProtoRepo, ProtoSize } from "./mockData";

export function pill(className: string, children: React.ReactNode, title?: string) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 rounded-full uppercase font-mono text-[9px] font-bold border inline-flex items-center gap-1 ${className}`}
    >
      {children}
    </span>
  );
}

/** size: small green · medium amber · oversized red */
export function sizePill(size: ProtoSize) {
  if (size === "small") {
    return pill("bg-emerald-500/10 text-emerald-400 border-emerald-500/30", "small");
  }
  if (size === "medium") {
    return pill("bg-amber-500/10 text-amber-300 border-amber-500/30", "medium");
  }
  return pill("bg-rose-500/10 text-rose-400 border-rose-500/35", "oversized");
}

/**
 * rating colors:
 * 1–5 red · 5–7 amber · 8–10 green · null = no score (amber)
 */
export function ratingPill(rating: number | null) {
  if (rating == null) {
    return pill("bg-amber-500/10 text-amber-300 border-amber-500/25", "no score");
  }
  if (rating >= 8) {
    return pill("bg-emerald-500/10 text-emerald-400 border-emerald-500/30", `${rating}/10`);
  }
  if (rating >= 5) {
    return pill("bg-amber-500/10 text-amber-300 border-amber-500/30", `${rating}/10`);
  }
  return pill("bg-rose-500/10 text-rose-400 border-rose-500/30", `${rating}/10`);
}

export function rgPill(ok: boolean, okLabel: string, failLabel: string, title?: string) {
  return pill(
    ok
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
      : "bg-rose-500/10 text-rose-400 border-rose-500/30",
    ok ? okLabel : failLabel,
    title,
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
          <span title="Issue tracker # ≠ GitHub PR #">
            Ticket #{pr.ticketNumber} ≠ PR #{pr.githubPrNumber}
          </span>
        )}
        <span className="truncate text-slate-600 max-w-[180px]">{pr.branch}</span>
      </div>
    </div>
  );
}

/** Main-content chip row: size · webhook · cloned · indexed · rating (+ merge outcome) */
export function MainStatusRow({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sizePill(pr.size)}
      {rgPill(
        repo.webhookConnected,
        "webhook on",
        "webhook off",
        repo.webhookConnected
          ? "GitHub ↔ Dragnet ON"
          : "GitHub ↔ Dragnet OFF — no auto events",
      )}
      {rgPill(repo.cloneOk, "cloned", "clone failed")}
      {rgPill(repo.indexOk, "indexed", "index missing")}
      {ratingPill(pr.rating)}
      {pr.mergeReady && pr.rating != null
        ? pill("bg-emerald-500/10 text-emerald-400 border-emerald-500/30", "merge ready")
        : pill(
            "bg-amber-500/10 text-amber-300 border-amber-500/25",
            "not ready",
            pr.mergeReason ?? undefined,
          )}
    </div>
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

/** @deprecated health strip replaced by MainStatusRow chips */
export function RepoHealthStrip({ repo }: { repo: ProtoRepo }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0F1219] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 mr-2">
        <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Active project</p>
        <p className="text-sm font-bold font-mono text-white truncate">{repo.name}</p>
      </div>
      {rgPill(repo.cloneOk, "cloned", "cloned")}
      {rgPill(repo.indexOk, "indexed", "indexed")}
      {rgPill(repo.webhookConnected, "webhook", "webhook")}
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
    return ratingPill(pr.rating);
  }
  return pill("bg-amber-500/10 text-amber-300 border-amber-500/25", "Not ready · no score");
}
