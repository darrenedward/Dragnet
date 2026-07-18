"use client";

import { Activity, Code2, Cpu, Database, GitBranch, ListTodo, Network, Users, ListChecks } from "lucide-react";
import type { ActiveTab, Repository } from "../lib/types";

interface Props {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  activeRepo?: Repository;
  selectedRepoId: string;
}

const TAB_TITLES: Record<ActiveTab, string> = {
  prs: "Manual PR Code Review Scanners",
  queue: "Durable Scan Queue",
  watcher: "Git Watcher Daemon: Configured Workspace",
  roadmap: "Dragnet Tracker: PRD Progress Roadmap",
  codebase: "Codebase AST Indexer & Call-Graph Tracer",
  llm_config: "LLM Router Configuration",
  team: "Team & Workspace Members",
  db_config: "Multi-Database Data Source Settings",
};

/**
 * Top-of-content-pane header: active project chip + section title +
 * horizontal tab switcher. The PR title used to live next to the chip
 * but was redundant with the sidebar's PR list — removed. Extracted
 * from App.tsx to keep the root component under the 500-line cap.
 */
export default function DashboardTitleBar({
  activeTab,
  setActiveTab,
  activeRepo,
  selectedRepoId,
}: Props) {
  return (
    <div className="p-4 sm:p-5 border-b border-white/5 flex flex-col sm:flex-row sm:items-end justify-between gap-4 bg-[#0F1219]/30 shrink-0">
      <div>
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Active Project:</span>
          <span className="text-xs font-semibold font-mono text-cyan-400 bg-cyan-400/10 px-1.5 py-0.5 rounded border border-cyan-400/20 shrink-0">
            {activeRepo?.name || selectedRepoId}
          </span>
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight flex items-center gap-2" id="workspace-main-branch-title">
          <GitBranch size={18} className="text-cyan-500" />
          <span>{TAB_TITLES[activeTab]}</span>
        </h2>
      </div>

      <div className="flex bg-slate-900 border border-white/10 p-1 rounded-lg self-start flex-wrap gap-1">
        <TabButton active={activeTab === "prs"} onClick={() => setActiveTab("prs")} icon={<Code2 size={13} />} label="Diff Scanner" />
        <TabButton active={activeTab === "queue"} onClick={() => setActiveTab("queue")} icon={<ListChecks size={13} />} label="Scan Queue" />
        <TabButton active={activeTab === "watcher"} onClick={() => setActiveTab("watcher")} icon={<Activity size={13} />} label="Git Watcher Daemon" />
        <TabButton active={activeTab === "codebase"} onClick={() => setActiveTab("codebase")} icon={<Network size={13} />} label="Codebase AST graph" id="tab-codebase-graph" />
        <TabButton active={activeTab === "roadmap"} onClick={() => setActiveTab("roadmap")} icon={<ListTodo size={13} />} label="PRD Task Roadmap" />
        <TabButton active={activeTab === "db_config"} onClick={() => setActiveTab("db_config")} icon={<Database size={13} />} label="Data Source Settings" id="tab-db-config" />
        <TabButton active={activeTab === "llm_config"} onClick={() => setActiveTab("llm_config")} icon={<Cpu size={13} />} label="Settings" id="tab-llm-config" />
        <TabButton active={activeTab === "team"} onClick={() => setActiveTab("team")} icon={<Users size={13} />} label="Team" id="tab-team" />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  id,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  id?: string;
}) {
  return (
    <button
      onClick={onClick}
      id={id}
      className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
        active ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
