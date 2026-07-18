"use client";

import { GitBranch } from "lucide-react";
import type { PullRequest } from "../../lib/types";
import { getStatusBadgeStyle } from "../../lib/types";
import PrSizeProfileChip from "../PrSizeProfileChip";

/**
 * Renders the active-PR list under a selected repo in the sidebar.
 * Extracted from DashboardSidebar.tsx (#69 PR 3) to keep the file
 * under the 500-line cap.
 */
export function PrList({
  prs,
  selectedPrId,
  onSelectPr,
}: {
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
}) {
  return (
    <div className="pl-3 py-1 space-y-1.5 border-l border-cyan-500/20 ml-4.5 mt-1 animate-fadeIn">
      {prs.length === 0 ? (
        <div className="py-2 text-left text-[10px] text-slate-600 font-mono italic pl-2">
          No detected active PRs
        </div>
      ) : (
        prs.map((pr) => (
          <PrRow
            key={pr.id}
            pr={pr}
            isPrSelected={selectedPrId === pr.id}
            onSelect={() => onSelectPr(pr.id)}
          />
        ))
      )}
    </div>
  );
}

function PrRow({ pr, isPrSelected, onSelect }: { pr: PullRequest; isPrSelected: boolean; onSelect: () => void }) {
  const hasPriorReview = pr.rating !== undefined && pr.rating !== null;
  const isPending = pr.status === "Pending";
  const statusClass = isPending && hasPriorReview
    ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
    : getStatusBadgeStyle(pr.status);
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-2 rounded-lg transition-all flex items-start gap-2 border ${
        isPrSelected
          ? "bg-indigo-500/10 border-indigo-500/30 text-white"
          : "bg-transparent border-transparent hover:bg-white/5 text-slate-400 hover:text-white"
      }`}
    >
      <div className={`p-1 mt-0.5 rounded shrink-0 ${isPrSelected ? "bg-indigo-600/90 text-white" : "bg-slate-800 text-slate-500"}`}>
        <GitBranch size={10} />
      </div>
      <div className="flex-1 min-w-0 font-mono">
        <div className="text-[11px] font-bold truncate text-slate-300">{pr.title}</div>
        <div className="flex items-center justify-between mt-0.5 text-[9px] text-slate-500">
          <span className="truncate max-w-[90px] text-cyan-400 font-semibold">{pr.sourceBranch}</span>
          <div className="flex items-center gap-1 shrink-0">
            {pr.sizeProfile && (
              <PrSizeProfileChip profile={pr.sizeProfile} compact />
            )}
            {pr.rating !== undefined && pr.rating !== null && (
              <span
                className={`px-1 py-0.2 rounded font-extrabold text-[7.5px] border leading-none shrink-0 ${
                  pr.rating >= 8
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                    : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                }`}
                title={pr.rating >= 8 ? "Production Ready" : "Requires Improvements"}
              >
                {pr.rating}/10
              </span>
            )}
            <span
              className={`px-1 py-0.2 rounded uppercase font-extrabold text-[7px] tracking-wide flex items-center gap-1 leading-none ${statusClass}`}
            >
              {pr.status === "In Progress" && (
                <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse shrink-0" />
              )}
              <span title={isPending ? (hasPriorReview ? "Code changed since the last completed review" : "This PR has not been reviewed yet") : undefined}>
                {pr.status}
              </span>
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}
