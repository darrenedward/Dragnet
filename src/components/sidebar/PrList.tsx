"use client";

import { GitBranch } from "lucide-react";
import type { PullRequest } from "../../lib/types";
import { buildSidebarPrRow } from "../../lib/prHeaderPresentation";
import { LayoutCPill } from "../views/prs/LayoutCChips";

/**
 * Renders the active-PR list under a selected repo in the sidebar.
 * Layout C: title, PR # · issue #, compact status + rating oblong pills.
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
  const row = buildSidebarPrRow({
    title: pr.title,
    githubPrNumber: pr.githubPrNumber,
    sourceBranch: pr.sourceBranch,
    status: pr.status,
    rating: pr.rating,
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      title={row.status.title}
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
        <div
          className={`text-[11px] font-bold truncate leading-snug ${
            isPrSelected ? "text-white" : "text-slate-300"
          }`}
        >
          {row.title}
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-[9px] min-w-0">
          <span className="text-slate-500 truncate flex-1 min-w-0">
            {row.prNumberLabel ? (
              <span className="text-cyan-400/90">{row.prNumberLabel}</span>
            ) : (
              <span className="text-cyan-400/70 truncate">{pr.sourceBranch}</span>
            )}
            {row.issueNumberLabel && (
              <>
                <span className="text-slate-600"> · </span>
                <span>{row.issueNumberLabel}</span>
              </>
            )}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {row.rating && <LayoutCPill chip={row.rating} compact />}
            <LayoutCPill chip={row.status} compact />
          </span>
        </div>
      </div>
    </button>
  );
}
