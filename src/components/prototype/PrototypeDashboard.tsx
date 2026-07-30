"use client";

import { useState } from "react";
import { Folder, GitBranch, X } from "lucide-react";
import { REPOS } from "./mockData";
import { RepoHealthStrip } from "./atoms";
import { VariantA, VariantB, VariantC } from "./variants";

/** Sidebar = nav only; main = health strip + PR. PROTOTYPE throwaway. */
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
      <aside className="w-60 shrink-0 border-r border-white/10 bg-[#0B0E14] flex flex-col">
        <div className="p-3 border-b border-white/5">
          <p className="text-[9px] font-mono uppercase tracking-widest text-cyan-500/80 font-bold">
            Your projects
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {REPOS.map((r) => (
            <div key={r.id}>
              <button
                type="button"
                onClick={() => selectRepo(r.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
                  r.id === repoId
                    ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
                    : "border-transparent hover:bg-white/5 text-slate-400"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Folder
                    size={14}
                    className={`shrink-0 ${r.id === repoId ? "text-cyan-400" : "text-slate-500"}`}
                  />
                  <span className="text-xs font-bold font-mono truncate flex-1" title={r.name}>
                    {r.name}
                  </span>
                  {!r.cloneOk && (
                    <X size={12} className="shrink-0 text-rose-400" strokeWidth={2.5} />
                  )}
                  <span
                    className={`shrink-0 text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded-full border ${
                      r.needsReviewCount > 0
                        ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                        : "bg-slate-800 text-slate-500 border-transparent"
                    }`}
                  >
                    {r.needsReviewCount > 0 ? r.needsReviewCount : r.prs.length}
                  </span>
                </div>
                <div className="text-[9px] font-mono text-slate-600 truncate mt-0.5 pl-5">
                  {r.githubUrl.replace("https://github.com/", "")}
                </div>
              </button>
              {r.id === repoId && (
                <div className="pl-2 ml-3 border-l border-cyan-500/20 space-y-1 py-1 mt-0.5">
                  {r.prs.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPrId(p.id)}
                      className={`w-full text-left p-2 rounded-lg flex gap-2 border transition-all ${
                        p.id === prId
                          ? "bg-indigo-500/10 border-indigo-500/30 text-white"
                          : "border-transparent hover:bg-white/5 text-slate-400"
                      }`}
                    >
                      <div
                        className={`p-1 mt-0.5 rounded shrink-0 ${
                          p.id === prId ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-500"
                        }`}
                      >
                        <GitBranch size={10} />
                      </div>
                      <div className="min-w-0 flex-1 font-mono">
                        <div className="text-[11px] font-bold truncate text-slate-300">
                          {p.title}
                          {p.ticketNumber != null && (
                            <span className="text-cyan-500/80"> #{p.ticketNumber}</span>
                          )}
                        </div>
                        <div className="flex justify-between gap-1 mt-0.5 text-[9px]">
                          <span className="text-cyan-400/80">PR #{p.githubPrNumber}</span>
                          <span className="flex items-center gap-1 shrink-0">
                            {p.rating != null && (
                              <span
                                className={
                                  p.rating >= 8 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"
                                }
                              >
                                {p.rating}/10
                              </span>
                            )}
                            <span className="text-slate-500 uppercase text-[7px] font-extrabold">
                              {!r.cloneOk && p.status === "Pending" ? "blocked" : p.status}
                            </span>
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-4 sm:p-5 overflow-y-auto space-y-4 bg-[#090C12]/50">
        <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider">
          Main content (Diff Scanner pane)
        </div>
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
