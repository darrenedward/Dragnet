"use client";

import { useEffect, useState } from "react";
import { Activity, Folder, GitBranch, Plus, Sparkles } from "lucide-react";
import type { ActivityLog, LlmPresetsState, PullRequest, Repository } from "../lib/types";
import { getStatusBadgeStyle } from "../lib/types";

interface Props {
  isSidebarOpen: boolean;
  onAddProject: () => void;
  repos: Repository[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
  onOpenLlmSettings: () => void;
  logs: ActivityLog[];
}

export default function DashboardSidebar({
  isSidebarOpen,
  onAddProject,
  repos,
  selectedRepoId,
  onSelectRepo,
  prs,
  selectedPrId,
  onSelectPr,
  onOpenLlmSettings,
  logs,
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
    // `greploop:llm-presets-changed` on save, which triggers an immediate
    // refresh via the handler below — that's the primary sync mechanism.
    const poller = setInterval(fetchLlmPresets, 10000);
    const onChanged = () => fetchLlmPresets();
    window.addEventListener("greploop:llm-presets-changed", onChanged);
    return () => {
      cancelled = true;
      clearInterval(poller);
      window.removeEventListener("greploop:llm-presets-changed", onChanged);
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
        prs={prs}
        selectedPrId={selectedPrId}
        onSelectPr={onSelectPr}
        onAddProject={onAddProject}
      />

      <LlmRouterPane state={llmPresets} onOpenSettings={onOpenLlmSettings} />

      <LogsPane logs={logs} />
    </aside>
  );
}

function ProjectsPane({
  repos,
  selectedRepoId,
  onSelectRepo,
  prs,
  selectedPrId,
  onSelectPr,
  onAddProject,
}: {
  repos: Repository[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
  onAddProject: () => void;
}) {
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
            <span>Add Project</span>
          </button>
        </div>
      </div>

      <div className="p-4 space-y-3 flex-1 overflow-y-auto min-h-0" id="project-navigation-list">
        {repos.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-600 font-mono">
            No workspace projects registered yet.
          </div>
        ) : (
          repos.map((repo) => {
            const isRepoSelected = selectedRepoId === repo.id;
            return (
              <div key={repo.id} className="space-y-1">
                <RepoRow
                  repo={repo}
                  isRepoSelected={isRepoSelected}
                  onSelect={() => onSelectRepo(repo.id)}
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

function RepoRow({
  repo,
  isRepoSelected,
  onSelect,
}: {
  repo: Repository;
  isRepoSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-lg transition-all border ${
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
          <span
            className={`text-[9px] font-mono font-extrabold px-1.5 py-0.2 rounded-full leading-tight ${
              (repo.prCount || 0) > 0
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                : "bg-slate-900 text-slate-600 border border-transparent"
            }`}
          >
            {repo.prCount || 0}
          </span>
        </div>
      </div>
      <div className="text-[9px] font-mono text-slate-500 truncate mt-0.5 pl-5">{repo.path}</div>
    </button>
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
        <div className="text-[11px] font-bold truncate text-slate-205">{pr.title}</div>
        <div className="flex items-center justify-between mt-0.5 text-[9px] text-slate-500">
          <span className="truncate max-w-[90px] text-cyan-400 font-semibold">{pr.sourceBranch}</span>
          <div className="flex items-center gap-1 shrink-0">
            {pr.rating !== undefined && pr.rating !== null && (
              <span
                className={`px-1 py-0.2 rounded font-extrabold text-[7.5px] border leading-none shrink-0 ${
                  pr.rating >= 9
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                    : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                }`}
                title={pr.rating >= 9 ? "Production Ready" : "Requires Improvements"}
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

function LogsPane({ logs }: { logs: ActivityLog[] }) {
  return (
    <div className="p-4 border-t border-white/5 bg-[#0A0D13]">
      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-3 font-extrabold font-mono">
        Recent Daemon Logs
      </div>
      <div className="space-y-2 max-h-24 overflow-y-auto pr-1">
        {logs.length === 0 ? (
          <div className="text-[10px] text-slate-600 font-mono">Waiting for git operations...</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex gap-2 text-[10px] font-mono leading-tight">
              <div className="mt-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <div className="flex-1 min-w-0">
                <div className="text-slate-200 truncate">{log.action}</div>
                <div className="text-[9px] text-slate-500">
                  {log.target} • {log.time}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
