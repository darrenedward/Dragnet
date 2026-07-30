"use client";

import { useState } from "react";
import { Folder, GitBranch, X } from "lucide-react";
import { REPOS } from "./mockData";
import { RepoHealthStrip } from "./atoms";
import { VariantA, VariantB, VariantC } from "./variants";

/** Sidebar = nav only (Image 1 style); main = health + PR card. No log excerpts. */
export function PrototypeDashboard({ variant }: { variant: "A" | "B" | "C" }) {
  const [repoId, setRepoId] = useState("nwatrade");
  const [prId, setPrId] = useState<string>("pr-31");

  const repo = REPOS.find((r) => r.id === repoId) ?? REPOS[0]!;
  const pr = repo.prs.find((p) => p.id === prId) ?? repo.prs[0] ?? null;

  const selectRepo = (id: string) => {
    setRepoId(id);
    const r = REPOS.find((x) => x.id === id)!;
    setPrId(r.prs[0]?.id ?? "");
  };

  return (
    <div className="flex min-h-[calc(100vh-10rem)] rounded-xl border border-white/10 overflow-hidden bg-[#090C12]">
      {/* Minimal sidebar — full names, PR list, no health/logs */}
      <aside className="w-64 shrink-0 border-r border-white/10 bg-[#0B0E14] flex flex-col">
        <div className="p-3 border-b border-white/5 space-y-2">
          <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500 font-bold">
            Your projects
          </p>
          <div className="flex flex-wrap gap-1">
            {REPOS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRepo(r.id)}
                className={`px-2 py-1 rounded-md text-[10px] font-mono font-bold border ${
                  r.id === repoId
                    ? "bg-cyan-500/15 border-cyan-500/30 text-cyan-300"
                    : "border-transparent text-slate-500 hover:bg-white/5"
                }`}
              >
                {r.name}
                {r.needsReviewCount > 0 && (
                  <span className="ml-1 text-amber-400">{r.needsReviewCount}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Active repo header — matches production minimal card */}
        <div className="px-3 py-3 border-b border-white/5">
          <div className="flex items-center gap-2 min-w-0">
            <Folder size={16} className="text-cyan-400 shrink-0" />
            <span className="text-sm font-bold font-mono text-white truncate flex-1" title={repo.name}>
              {repo.name}
            </span>
            {!repo.cloneOk && <X size={14} className="text-rose-400 shrink-0" strokeWidth={2.5} />}
            <span
              className={`text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded-full border ${
                repo.needsReviewCount > 0
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/35"
                  : "bg-slate-800 text-slate-500 border-transparent"
              }`}
            >
              {repo.needsReviewCount > 0 ? repo.needsReviewCount : repo.prs.length}
            </span>
          </div>
          <p className="text-[10px] font-mono text-slate-500 truncate mt-1 pl-6">
            {repo.githubUrl.replace("https://github.com/", "")}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <p className="px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-slate-600 font-bold">
            Overview
          </p>
          {repo.prs.map((p) => {
            const blocked = !repo.cloneOk && p.status === "Pending";
            const statusLabel = blocked ? "BLOCKED" : p.status.toUpperCase();
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPrId(p.id)}
                className={`w-full text-left p-2.5 rounded-xl flex gap-2 border transition-all ${
                  p.id === prId
                    ? "bg-indigo-500/10 border-indigo-500/35 text-white"
                    : "border-transparent hover:bg-white/5 text-slate-400"
                }`}
              >
                <div
                  className={`p-1.5 mt-0.5 rounded-lg shrink-0 ${
                    p.id === prId ? "bg-indigo-600 text-white" : "bg-slate-800/80 text-slate-500"
                  }`}
                >
                  <GitBranch size={12} />
                </div>
                <div className="min-w-0 flex-1 font-mono">
                  <div className="text-[11px] font-bold truncate text-slate-200 leading-snug">
                    {p.title}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1 text-[9px]">
                    <span className="text-slate-500 truncate">
                      <span className="text-cyan-400/90">PR #{p.githubPrNumber}</span>
                      {p.ticketNumber != null && (
                        <>
                          <span className="text-slate-600"> · </span>
                          <span className="text-slate-400">ticket #{p.ticketNumber}</span>
                        </>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {p.rating != null && (
                        <span
                          className={
                            p.rating >= 8 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"
                          }
                        >
                          {p.rating}/10
                        </span>
                      )}
                      <span
                        className={`uppercase text-[8px] font-extrabold tracking-wide ${
                          blocked ? "text-amber-400" : "text-slate-500"
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-4 sm:p-5 overflow-y-auto space-y-4 bg-[#090C12]/50">
        <RepoHealthStrip repo={repo} />
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
