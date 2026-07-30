"use client";

import { AlertTriangle, Zap } from "lucide-react";
import type { ProtoPr, ProtoPrStatus, ProtoRepo, ProtoSize } from "./mockData";

export function pill(
  className: string,
  children: React.ReactNode,
  title?: string,
  compact?: boolean,
) {
  return (
    <span
      title={title}
      className={`${compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]"} rounded-full uppercase font-mono font-bold border inline-flex items-center gap-1 cursor-help ${className}`}
    >
      {children}
    </span>
  );
}

const SIZE_TIP: Record<ProtoSize, string> = {
  small:
    "Small PR — quick scan. Few files/lines so the review stays sharp and finishes fast.",
  medium:
    "Medium PR — normal scan cost. Still within the usual review budget.",
  oversized:
    "Oversized PR — large diff. Scan will take longer and may miss cross-file issues; split if you can.",
};

const STATUS_TIP: Record<ProtoPrStatus, string> = {
  pending:
    "Pending — waiting to enter the scan queue. Not running yet.",
  queued:
    "Queued — admitted to the scan queue. Position depends on how many jobs are ahead.",
  completed:
    "Completed — a scan finished. Check the rating chip to see if it is merge-ready (8+).",
};

/** size: small green · medium amber · oversized red */
export function sizePill(size: ProtoSize) {
  if (size === "small") {
    return pill("bg-emerald-500/10 text-emerald-400 border-emerald-500/30", "small", SIZE_TIP.small);
  }
  if (size === "medium") {
    return pill("bg-amber-500/10 text-amber-300 border-amber-500/30", "medium", SIZE_TIP.medium);
  }
  return pill("bg-rose-500/10 text-rose-400 border-rose-500/35", "oversized", SIZE_TIP.oversized);
}

/**
 * rating colors:
 * 1–4 red · 5–7 amber · 8–10 green · null = no score (amber)
 */
export function ratingPill(rating: number | null, compact?: boolean) {
  if (rating == null) {
    return pill(
      "bg-amber-500/10 text-amber-300 border-amber-500/25",
      "no score",
      "No trusted score — scan finished without a usable rating (e.g. findings rejected after the model scored 10). Not merge-ready.",
      compact,
    );
  }
  if (rating >= 8) {
    return pill(
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
      `${rating}/10`,
      `${rating}/10 — at or above the merge bar (need 8+). Merge-ready if other gates pass.`,
      compact,
    );
  }
  if (rating >= 5) {
    return pill(
      "bg-amber-500/10 text-amber-300 border-amber-500/30",
      `${rating}/10`,
      `${rating}/10 — below the merge bar (need 8+). Fix findings and re-scan.`,
      compact,
    );
  }
  return pill(
    "bg-rose-500/10 text-rose-400 border-rose-500/30",
    `${rating}/10`,
    `${rating}/10 — well below the merge bar. Expect serious issues; fix and re-scan.`,
    compact,
  );
}

/** pending amber · queued/processing blue · completed green */
export function statusPill(
  status: ProtoPrStatus,
  queuePos?: number | null,
  compact?: boolean,
) {
  const base = STATUS_TIP[status];
  const tip =
    (status === "queued" || status === "pending") && queuePos != null
      ? `${base} Currently #${queuePos} in the queue.`
      : base;
  const label =
    status === "queued"
      ? queuePos != null
        ? `processing #${queuePos}`
        : "processing"
      : status === "pending" && queuePos != null
        ? `pending #${queuePos}`
        : status;

  if (status === "pending") {
    return pill(
      "bg-amber-500/10 text-amber-300 border-amber-500/30",
      label,
      tip,
      compact,
    );
  }
  if (status === "queued") {
    return pill(
      "bg-sky-500/10 text-sky-300 border-sky-500/35",
      label,
      tip,
      compact,
    );
  }
  return pill(
    "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    label,
    tip,
    compact,
  );
}

export function rgPill(ok: boolean, okLabel: string, failLabel: string, titleOk: string, titleFail: string) {
  return pill(
    ok
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
      : "bg-rose-500/10 text-rose-400 border-rose-500/30",
    ok ? okLabel : failLabel,
    ok ? titleOk : titleFail,
  );
}

/**
 * Two lines:
 *   GITHUB
 *   PR #31 - feat(admin): Add PM User page…
 *   ISSUE #25 - ticket-25-admin-pm-user
 * (no ticket → ISSUE line omitted; branch still on ISSUE when present)
 */
export function PrIdentity({ pr }: { pr: ProtoPr }) {
  return (
    <div className="space-y-2 min-w-0 font-mono">
      <div className="space-y-0.5">
        <div className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">GitHub</div>
        <div className="text-sm sm:text-base font-bold text-white leading-snug">
          <span className="text-cyan-400">PR #{pr.githubPrNumber}</span>
          <span className="text-slate-500 font-semibold"> — </span>
          <span>{pr.title}</span>
        </div>
      </div>
      {pr.ticketNumber != null && (
        <div className="space-y-0.5">
          <div className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Issue</div>
          <div className="text-sm font-semibold text-slate-200 leading-snug">
            <span className="text-cyan-300/90">#{pr.ticketNumber}</span>
            <span className="text-slate-500"> — </span>
            <span className="text-slate-400" title={pr.branch}>
              {pr.branch}
            </span>
          </div>
        </div>
      )}
      {pr.ticketNumber == null && (
        <div className="text-[11px] text-slate-500 truncate" title={pr.branch}>
          {pr.branch}
        </div>
      )}
    </div>
  );
}

/** Main chips: status · size · webhook · cloned · indexed · rating · merge */
export function MainStatusRow({
  repo,
  pr,
  queuePos,
}: {
  repo: ProtoRepo;
  pr: ProtoPr;
  queuePos?: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {statusPill(pr.status, queuePos)}
      {sizePill(pr.size)}
      {rgPill(
        repo.webhookConnected,
        "webhook on",
        "webhook off",
        "Webhook on — GitHub notifies Dragnet on push and PR events (installed + processing).",
        "Webhook off — no automatic GitHub → Dragnet events. Scans only run when you trigger them.",
      )}
      {rgPill(
        repo.cloneOk,
        "cloned",
        "clone failed",
        "Clone OK — local checkout is ready for scans.",
        "Clone failed — repo checkout is missing or broken. Fix clone before scans can run.",
      )}
      {rgPill(
        repo.indexOk,
        "indexed",
        "index missing",
        "Indexed — AST/symbol index is present for smarter review context.",
        "Index missing — run Index now so reviews have codebase context.",
      )}
      {ratingPill(pr.rating)}
      {pr.mergeReady && pr.rating != null
        ? pill(
            "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
            "merge ready",
            "Merge ready — rating ≥ 8 and gates passed. Safe to merge from Dragnet’s point of view.",
          )
        : pill(
            "bg-amber-500/10 text-amber-300 border-amber-500/25",
            "not ready",
            pr.mergeReason
              ? `Not merge-ready — ${pr.mergeReason}`
              : "Not merge-ready — need rating ≥ 8 with gates complete. Completed ≠ merge-ready.",
          )}
    </div>
  );
}

export function Actions({ disabled }: { disabled?: boolean }) {
  const base =
    "h-8 px-3 text-[11px] font-bold rounded-md inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap self-start";
  return (
    <div className="flex gap-1.5 shrink-0 self-start">
      <button
        type="button"
        disabled={disabled}
        title={
          disabled
            ? "Disabled while clone is failed — fix the repo checkout first."
            : "Queue a full PR review scan now."
        }
        className={`${base} ${
          disabled
            ? "bg-slate-700 text-slate-500 cursor-not-allowed"
            : "bg-gradient-to-r from-cyan-500 to-indigo-500 text-black shadow-sm"
        }`}
      >
        <Zap size={12} className={disabled ? "" : "fill-black"} />
        Run PR Review
      </button>
      <button
        type="button"
        disabled={disabled}
        title={
          disabled
            ? "Disabled while clone is failed."
            : "Force a fresh scan, ignoring cache / freshness shortcuts."
        }
        className={`${base} font-mono ${
          disabled
            ? "bg-slate-800/50 border border-slate-700 text-slate-600 cursor-not-allowed"
            : "bg-rose-500/15 border border-rose-500/30 text-rose-300"
        }`}
      >
        <AlertTriangle size={12} />
        Force re-scan
      </button>
    </div>
  );
}

export function RepoHealthStrip({ repo }: { repo: ProtoRepo }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0F1219] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 mr-2">
        <p className="text-[9px] font-mono uppercase tracking-wider text-slate-500">Active project</p>
        <p className="text-sm font-bold font-mono text-white truncate">{repo.name}</p>
      </div>
      {rgPill(repo.cloneOk, "cloned", "clone failed", "Clone OK", "Clone failed")}
      {rgPill(repo.indexOk, "indexed", "index missing", "Indexed", "Index missing")}
      {rgPill(repo.webhookConnected, "webhook on", "webhook off", "Webhook on", "Webhook off")}
    </div>
  );
}

export function MergeChip({ pr }: { pr: ProtoPr }) {
  return ratingPill(pr.rating);
}
