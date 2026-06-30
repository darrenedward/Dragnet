"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, CheckCircle2, Folder, GitBranch, Loader2, Plus, Settings, Sparkles, XCircle } from "lucide-react";
import type { LlmPresetsState, PullRequest, Repository } from "../lib/types";
import { getStatusBadgeStyle } from "../lib/types";
import PrSizeProfileChip from "./PrSizeProfileChip";

interface Props {
  isSidebarOpen: boolean;
  onAddProject: () => void;
  repos: Repository[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onEditRepo: (repo: Repository) => void;
  onRepoSettings: (repo: Repository) => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
  onOpenLlmSettings: () => void;
}

export default function DashboardSidebar({
  isSidebarOpen,
  onAddProject,
  repos,
  selectedRepoId,
  onSelectRepo,
  onEditRepo,
  onRepoSettings,
  prs,
  selectedPrId,
  onSelectPr,
  onOpenLlmSettings,
}: Props) {
  const [llmPresets, setLlmPresets] = useState<LlmPresetsState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchLlmPresets = async () => {
      try {
        const res = await fetch("/api/llm/presets");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setLlmPresets(data);
      } catch {
        // silently leave pane empty — the LLM Settings tab is the source of truth
      }
    };
    fetchLlmPresets();
    // Re-poll every 10s as a safety net so the sidebar eventually reflects
    // saves done elsewhere. The LlmConfigView also dispatches
    // `dragnet:llm-presets-changed` on save, which triggers an immediate
    // refresh via the handler below — that's the primary sync mechanism.
    const poller = setInterval(fetchLlmPresets, 10000);
    const onChanged = () => fetchLlmPresets();
    window.addEventListener("dragnet:llm-presets-changed", onChanged);
    return () => {
      cancelled = true;
      clearInterval(poller);
      window.removeEventListener("dragnet:llm-presets-changed", onChanged);
    };
  }, []);

  return (
    <aside
      className={`
        absolute md:relative inset-y-0 left-0 transform ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        md:translate-x-0 transition-transform duration-200 ease-in-out
        w-72 border-r border-white/10 bg-[#0F1219] flex flex-col z-30 shrink-0 select-none
      `}
      id="sidebar-panel-container"
    >
        <ProjectsPane
          repos={repos}
          selectedRepoId={selectedRepoId}
          onSelectRepo={onSelectRepo}
          onEditRepo={onEditRepo}
          onRepoSettings={onRepoSettings}
          prs={prs}
          selectedPrId={selectedPrId}
          onSelectPr={onSelectPr}
          onAddProject={onAddProject}
        />

      <LlmRouterPane state={llmPresets} onOpenSettings={onOpenLlmSettings} />
    </aside>
  );
}

function ProjectsPane({
  repos,
  selectedRepoId,
  onSelectRepo,
  onEditRepo,
  onRepoSettings,
  prs,
  selectedPrId,
  onSelectPr,
  onAddProject,
}: {
  repos: Repository[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onEditRepo: (repo: Repository) => void;
  onRepoSettings: (repo: Repository) => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
  onAddProject: () => void;
}) {
  const sortedRepos = useMemo(
    () => [...repos].sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  const repoReviewStatus = useMemo(() => {
    const map = new Map<string, "idle" | "scanning" | "complete" | "failed">();
    for (const repo of repos) {
      const repoPrs = prs.filter((p) => p.repoId === repo.id);
      if (repoPrs.length === 0) {
        map.set(repo.id, "idle");
        continue;
      }
      const hasScanning = repoPrs.some((p) => p.status === "In Progress");
      const hasFailed = repoPrs.some((p) => p.status === "Failed");
      const allRated = repoPrs.every((p) => p.rating != null);
      if (hasScanning) map.set(repo.id, "scanning");
      else if (hasFailed) map.set(repo.id, "failed");
      else if (allRated) map.set(repo.id, "complete");
      else map.set(repo.id, "idle");
    }
    return map;
  }, [repos, prs]);

  return (
    <>
      <div className="p-4 border-b border-white/5 shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-cyan-400 font-extrabold font-mono">
            Workspace Projects
          </h2>
          <button
            onClick={onAddProject}
            className="bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 text-xs font-mono px-2 py-1 rounded transition-colors flex items-center gap-1 border border-cyan-500/20"
            title="Add local git directory"
          >
            <Plus size={11} />
            <span>Add</span>
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3 flex-1 overflow-y-auto min-h-0" id="project-navigation-list">
        {sortedRepos.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-600 font-mono">
            No workspace projects registered yet.
          </div>
        ) : (
          sortedRepos.map((repo) => {
            const isRepoSelected = selectedRepoId === repo.id;
            return (
              <div key={repo.id} className="space-y-1">
                <RepoRow
                  repo={repo}
                  isRepoSelected={isRepoSelected}
                  reviewStatus={repoReviewStatus.get(repo.id) || "idle"}
                  onSelect={() => onSelectRepo(repo.id)}
                  onEdit={() => onEditRepo(repo)}
                  onRepoSettings={() => onRepoSettings(repo)}
                />
                {isRepoSelected && (
                  <PrList
                    prs={prs}
                    selectedPrId={selectedPrId}
                    onSelectPr={onSelectPr}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; badgeClass: string }> = {
  scanning: {
    icon: <Loader2 size={9} className="animate-spin" />,
    label: "Scanning",
    badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  },
  complete: {
    icon: <CheckCircle2 size={9} />,
    label: "Complete",
    badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
  failed: {
    icon: <XCircle size={9} />,
    label: "Failed",
    badgeClass: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  },
  idle: {
    icon: null,
    label: "",
    badgeClass: "bg-slate-900 text-slate-600 border-transparent",
  },
};

function RepoRow({
  repo,
  isRepoSelected,
  reviewStatus,
  onSelect,
  onEdit,
  onRepoSettings,
}: {
  repo: Repository;
  isRepoSelected: boolean;
  reviewStatus: string;
  onSelect: () => void;
  onEdit: () => void;
  onRepoSettings: () => void;
}) {
  const statusCfg = STATUS_CONFIG[reviewStatus] || STATUS_CONFIG.idle;
  const prCount = repo.prCount || 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`relative w-full text-left px-3 py-2 rounded-lg transition-all border cursor-pointer ${
        isRepoSelected
          ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400 shadow-[inset_0_1px_5px_rgba(6,182,212,0.05)]"
          : "border-transparent hover:bg-white/5 text-slate-400 hover:text-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Folder size={13} className={isRepoSelected ? "text-cyan-400" : "text-slate-500"} />
          <span className="text-xs font-bold tracking-tight truncate font-mono">{repo.name}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[8px] font-mono px-1 rounded bg-slate-800 text-slate-400 font-bold">
            {repo.triggerMode}
          </span>
          {prCount > 0 ? (
            <span
              className={`text-[9px] font-mono font-extrabold px-1.5 py-0.2 rounded-full leading-tight border flex items-center gap-1 ${statusCfg.badgeClass}`}
              title={`${prCount} PRs — ${statusCfg.label || "No reviews yet"}`}
            >
              {statusCfg.icon}
              <span>{prCount}</span>
              {statusCfg.label && (
                <span className="hidden xl:inline text-[7px] uppercase tracking-wider">{statusCfg.label}</span>
              )}
            </span>
          ) : (
            <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.2 rounded-full leading-tight bg-slate-900 text-slate-600 border border-transparent">
              0
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRepoSettings();
            }}
            aria-label={`Repo settings & index stats for ${repo.name}`}
            title="Repo settings & index stats"
            className="text-slate-500 hover:text-cyan-400 transition-all cursor-pointer"
          >
            <BarChart3 size={12} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            aria-label={`Edit connection details for ${repo.name}`}
            title="Edit connection details"
            className="text-slate-500 hover:text-cyan-400 transition-all cursor-pointer"
          >
            <Settings size={12} />
          </button>
        </div>
      </div>
      <div className="text-[9px] font-mono text-slate-500 truncate mt-0.5 pl-5">
        {repo.path || repo.cloneUrl || repo.id}
      </div>
    </div>
  );
}

function PrList({
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
              className={`px-1 py-0.2 rounded uppercase font-extrabold text-[7px] tracking-wide flex items-center gap-1 leading-none ${getStatusBadgeStyle(pr.status)}`}
            >
              {pr.status === "In Progress" && (
                <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse shrink-0" />
              )}
              <span>{pr.status}</span>
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

function LlmRouterPane({
  state,
  onOpenSettings,
}: {
  state: LlmPresetsState | null;
  onOpenSettings: () => void;
}) {
  const activeChat = state?.presets.find((p) => p.id === state.activeChatPresetId) || null;
  const chatModel = activeChat?.chatModel || "";
  const shortModel = chatModel.split("/").pop() || chatModel;

  return (
    <div className="p-4 border-white/5 bg-slate-950/45 border-t">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-extrabold font-mono">
          LLM Router
        </h2>
        <button
          onClick={onOpenSettings}
          className="text-[9px] text-cyan-400 hover:text-cyan-300 font-mono uppercase tracking-wider flex items-center gap-1"
          title="Open LLM Settings tab"
        >
          <Sparkles size={10} />
          <span>Configure</span>
        </button>
      </div>
      <div className="bg-slate-900/60 p-2.5 rounded-lg border border-white/5">
        <div className="text-[8px] text-slate-500 uppercase font-mono block mb-0.5">Active Chat Model</div>
        {activeChat && chatModel ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-cyan-400 font-mono font-bold truncate" title={`${activeChat.name} · ${chatModel}`}>
              {activeChat.name} · {shortModel}
            </span>
            {activeChat.hasApiKey ? (
              <span className="text-[8px] text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 font-mono uppercase shrink-0">
                Key Set
              </span>
            ) : (
              <span className="text-[8px] text-amber-400 bg-amber-500/10 px-1 py-0.5 rounded border border-amber-500/20 font-mono uppercase shrink-0">
                No Key
              </span>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-slate-600 font-mono italic">
            Not configured —{" "}
            <button onClick={onOpenSettings} className="text-cyan-400 hover:underline not-italic">
              set up
            </button>
          </div>
        )}
        {activeChat?.endpoint && (
          <div className="text-[8px] text-slate-600 font-mono truncate mt-1">
            {activeChat.endpoint.replace(/^https?:\/\//, "").split("/")[0]}
          </div>
        )}
      </div>
    </div>
  );
}
