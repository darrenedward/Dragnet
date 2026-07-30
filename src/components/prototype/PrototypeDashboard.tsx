"use client";

import { useState } from "react";
import { Folder, GitBranch, X } from "lucide-react";
import { REPOS } from "./mockData";
import { VariantA, VariantB, VariantC } from "./variants";

/**
 * Sidebar: one repo per row (scrolls for 30+). Expand = PR list.
 * PR row status = pending | queued | completed only.
 * Main: size / webhook / cloned / indexed / rating chips.
 */
export function PrototypeDashboard({ variant }: { variant: "A" | "B" | "C" }) {
  const [repoId, setRepoId] = useState("nwatrade");
  const [prId, setPrId] = useState<string>("pr-18");

  const repo = REPOS.find((r) => r.id === repoId) ?? REPOS[0]!;
  const pr = repo.prs.find((p) => p.id === prId) ?? repo.prs[0] ?? null;

  const selectRepo = (id: string) => {
    setRepoId(id);
    const r = REPOS.find((x) => x.id === id)!;
    setPrId(r.prs[0]?.id ?? "");
  };

  return (
    <div className="flex min-h-[calc(100vh-10rem)] rounded-xl border border-white/10 overflow-hidden bg-[#090C12]">
      <aside className="w-72 shrink-0 border-r border-white/10 bg-[#0B0E14] flex flex-col">
        <div className="px-3 py-2.5 border-b border-white/5">
          <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500 font-bold">
            Your projects
          </p>
        </div>

        {/* Vertical list — one repo per row; scrolls when many */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {REPOS.map((r) => {
            const open = r.id === repoId;
            return (
              <div key={r.id}>
                <button
                  type="button"
                  onClick={() => selectRepo(r.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition-all ${
                    open
                      ? "bg-cyan-500/10 border-cyan-500/30"
                      : "border-transparent hover:bg-white/5"
                  }`}
                >
                  {/* single row: icon · full name · fail · badge */}
                  <div className="flex items-center gap-2 min-w-0 h-7">
                    <Folder
                      size={14}
                      className={`shrink-0 ${open ? "text-cyan-400" : "text-slate-500"}`}
                    />
                    <span
                      className={`text-xs font-bold font-mono truncate flex-1 ${
                        open ? "text-cyan-200" : "text-slate-300"
                      }`}
                      title={r.name}
                    >
                      {r.name}
                    </span>
                    {!r.cloneOk && (
                      <X size={12} className="shrink-0 text-rose-400" strokeWidth={2.5} />
                    )}
                    <span
                      className={`shrink-0 text-[9px] font-mono font-extrabold min-w-[1.25rem] text-center px-1.5 py-0.5 rounded-full border ${
                        r.needsReviewCount > 0
                          ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                          : "bg-slate-800 text-slate-500 border-transparent"
                      }`}
                    >
                      {r.needsReviewCount > 0 ? r.needsReviewCount : r.prs.length}
                    </span>
                  </div>
                </button>

                {open && (
                  <div className="ml-3 pl-2 border-l border-white/10 space-y-0.5 py-1 mb-1">
                    <p className="px-1 py-0.5 text-[8px] font-mono uppercase tracking-wider text-slate-600 font-bold">
                      Overview
                    </p>
                    {r.prs.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPrId(p.id)}
                        className={`w-full text-left p-2 rounded-lg flex gap-2 border transition-all ${
                          p.id === prId
                            ? "bg-indigo-500/10 border-indigo-500/35"
                            : "border-transparent hover:bg-white/5"
                        }`}
                      >
                        <div
                          className={`p-1 mt-0.5 rounded shrink-0 ${
                            p.id === prId
                              ? "bg-indigo-600 text-white"
                              : "bg-slate-800 text-slate-500"
                          }`}
                        >
                          <GitBranch size={10} />
                        </div>
                        <div className="min-w-0 flex-1 font-mono">
                          <div
                            className={`text-[11px] font-bold truncate leading-snug ${
                              p.id === prId ? "text-white" : "text-slate-300"
                            }`}
                          >
                            {p.title}
                          </div>
                          <div className="flex items-center justify-between gap-1 mt-0.5 text-[9px]">
                            <span className="text-slate-500 truncate">
                              <span className="text-cyan-400/90">PR #{p.githubPrNumber}</span>
                              {p.ticketNumber != null && (
                                <>
                                  <span className="text-slate-600"> · </span>
                                  <span>ticket #{p.ticketNumber}</span>
                                </>
                              )}
                            </span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              {p.rating != null && (
                                <span
                                  className={
                                    p.rating >= 8
                                      ? "text-emerald-400 font-bold"
                                      : p.rating >= 5
                                        ? "text-amber-300 font-bold"
                                        : "text-rose-400 font-bold"
                                  }
                                >
                                  {p.rating}/10
                                </span>
                              )}
                              <span className="text-slate-500 uppercase text-[8px] font-extrabold tracking-wide">
                                {p.status}
                              </span>
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-4 sm:p-5 overflow-y-auto space-y-4 bg-[#090C12]/50">
        {pr ? (
          <>
            {variant === "A" && <VariantA repo={repo} pr={pr} />}
            {variant === "B" && <VariantB repo={repo} pr={pr} />}
            {variant === "C" && <VariantC repo={repo} pr={pr} />}
          </>
        ) : (
          <p className="text-sm font-mono text-slate-500">Select a PR from the sidebar.</p>
        )}
      </main>
    </div>
  );
}
