"use client";

import { GitBranch } from "lucide-react";
import type { PullRequest } from "../../lib/types";
import {
  layoutCCompactPillClassName,
  presentSidebarPrRow,
} from "../../lib/sidebarPrRow";

/**
 * Renders the active-PR list under a selected repo in the sidebar.
 * Layout-C: title, `PR #N · issue #M`, compact status + rating oblong pills.
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
    <div className="pl-3 py-1 space-y-0.5 border-l border-cyan-500/20 ml-4.5 mt-1 animate-fadeIn">
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
  const row = presentSidebarPrRow({
    title: pr.title,
    sourceBranch: pr.sourceBranch,
    githubPrNumber: pr.githubPrNumber,
    status: pr.status,
    rating: pr.rating,
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`sidebar-pr-${pr.id}`}
      title={row.status.tooltip}
      className={`w-full text-left p-2 rounded-lg transition-all flex items-start gap-2 border ${
        isPrSelected
          ? "bg-indigo-500/10 border-indigo-500/35 text-white"
          : "bg-transparent border-transparent hover:bg-white/5 text-slate-400 hover:text-white"
      }`}
    >
      <div className={`p-1 mt-0.5 rounded shrink-0 ${isPrSelected ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-500"}`}>
        <GitBranch size={10} />
      </div>
      <div className="min-w-0 flex-1 font-mono">
        <div
          className={`text-[11px] font-bold truncate leading-snug ${
            isPrSelected ? "text-white" : "text-slate-300"
          }`}
          title={row.title}
        >
          {row.title}
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-[9px] min-w-0">
          {row.identityLine ? (
            <span className="text-slate-500 truncate flex-1 min-w-0" data-testid={`sidebar-pr-identity-${pr.id}`}>
              {row.identityLine.split(" · ").map((part, i) => (
                <span key={part}>
                  {i > 0 && <span className="text-slate-600"> · </span>}
                  <span className={part.startsWith("PR #") ? "text-cyan-400/90" : undefined}>
                    {part}
                  </span>
                </span>
              ))}
            </span>
          ) : (
            <span className="text-slate-600 truncate flex-1 min-w-0" title={pr.sourceBranch}>
              {pr.sourceBranch}
            </span>
          )}
          <span className="flex items-center gap-1 shrink-0">
            {row.rating && (
              <span
                title={row.rating.tooltip}
                data-testid={`sidebar-pr-rating-${pr.id}`}
                className={layoutCCompactPillClassName(row.rating.tone)}
              >
                {row.rating.label}
              </span>
            )}
            <span
              title={row.status.tooltip}
              data-testid={`sidebar-pr-status-${pr.id}`}
              className={layoutCCompactPillClassName(row.status.tone)}
            >
              {row.status.kind === "processing" && (
                <span className="inline-block w-1 h-1 rounded-full bg-sky-400 animate-pulse shrink-0" />
              )}
              {row.status.label}
            </span>
          </span>
        </div>
      </div>
    </button>
  );
}
