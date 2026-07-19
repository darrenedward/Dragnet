"use client";

import { useMemo } from "react";
import {
  BarChart3,
  AlertCircle,
  CheckCircle2,
  Folder,
  KeyRound,
  Loader2,
  Plus,
  Settings,
  Users,
  XCircle,
} from "lucide-react";
import type { PullRequest, Repository } from "../../lib/types";
import { splitSidebarRepos, type SidebarUserRepo } from "../../lib/sidebarFilters";
import { PrList } from "./PrList";

/**
 * "Your projects" + "Shared with you" sections of the sidebar.
 * Extracted from DashboardSidebar.tsx (#69 PR 3) to keep the file
 * under the 500-line cap.
 *
 * The split is computed by the pure `splitSidebarRepos` helper —
 * this component is dumb on top of that.
 */
export function ProjectsSidebar({
  repos,
  userRepos,
  currentUserId,
  selectedRepoId,
  onSelectRepo,
  onEditRepo,
  onRepoSettings,
  onMintKey,
  onAddProject,
  prs,
  selectedPrId,
  onSelectPr,
}: {
  repos: Repository[];
  userRepos: SidebarUserRepo[];
  currentUserId: string | null;
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onEditRepo: (repo: Repository) => void;
  onRepoSettings: (repo: Repository) => void;
  onMintKey: (repo: { id: string; name: string }) => void;
  onAddProject: () => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
}) {
  const split = useMemo(
    () => splitSidebarRepos(repos, userRepos, currentUserId ?? ""),
    [repos, userRepos, currentUserId],
  );
  const yourProjects = split.yourProjects;
  const sharedProjects = split.sharedProjects;

  const yourRepoById = useMemo(() => {
    const m = new Map<string, Repository>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  const repoReviewStatus = useMemo(() => {
    const map = new Map<string, "idle" | "scanning" | "complete" | "failed" | "pending" | "changes">();
    for (const repo of repos) {
      const repoPrs = prs.filter((p) => p.repoId === repo.id);
      if (repoPrs.length === 0) {
        map.set(repo.id, "idle");
        continue;
      }
      const hasScanning = repoPrs.some((p) => p.status === "In Progress");
      const hasFailed = repoPrs.some((p) => p.status === "Failed");
      const hasPending = repoPrs.some((p) => p.status === "Pending");
      const hasChanges = repoPrs.some((p) => p.status === "Pending" && p.rating != null);
      const allRated = repoPrs.every((p) => p.rating != null);
      if (hasScanning) map.set(repo.id, "scanning");
      else if (hasFailed) map.set(repo.id, "failed");
      else if (hasChanges) map.set(repo.id, "changes");
      else if (hasPending) map.set(repo.id, "pending");
      else if (allRated) map.set(repo.id, "complete");
      else map.set(repo.id, "idle");
    }
    return map;
  }, [repos, prs]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" id="project-navigation-list">
      <YourProjectsPane
        repos={repos.filter((r) => yourProjects.some((yp) => yp.id === r.id))}
        repoReviewStatus={repoReviewStatus}
        selectedRepoId={selectedRepoId}
        onSelectRepo={onSelectRepo}
        onEditRepo={onEditRepo}
        onRepoSettings={onRepoSettings}
        onMintKey={onMintKey}
        onAddProject={onAddProject}
        prs={prs}
        selectedPrId={selectedPrId}
        onSelectPr={onSelectPr}
      />
      <SharedProjectsPane
        sharedProjects={sharedProjects}
        repoReviewStatus={repoReviewStatus}
        yourRepoById={yourRepoById}
        selectedRepoId={selectedRepoId}
        onSelectRepo={onSelectRepo}
        onMintKey={onMintKey}
        prs={prs}
        selectedPrId={selectedPrId}
        onSelectPr={onSelectPr}
      />
    </div>
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
  pending: {
    icon: <AlertCircle size={9} />,
    label: "Needs review",
    badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  },
  changes: {
    icon: <AlertCircle size={9} />,
    label: "Changes detected",
    badgeClass: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  },
  idle: {
    icon: null,
    label: "",
    badgeClass: "bg-slate-900 text-slate-600 border-transparent",
  },
};

function YourProjectsPane({
  repos,
  repoReviewStatus,
  selectedRepoId,
  onSelectRepo,
  onEditRepo,
  onRepoSettings,
  onMintKey,
  onAddProject,
  prs,
  selectedPrId,
  onSelectPr,
}: {
  repos: Repository[];
  repoReviewStatus: Map<string, "idle" | "scanning" | "complete" | "failed" | "pending" | "changes">;
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onEditRepo: (repo: Repository) => void;
  onRepoSettings: (repo: Repository) => void;
  onMintKey: (repo: { id: string; name: string }) => void;
  onAddProject: () => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
}) {
  const sortedRepos = useMemo(
    () => [...repos].sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );
  return (
    <div className="p-4 border-b border-white/5" data-testid="sidebar-your-section">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-cyan-400 font-extrabold font-mono">
          Your projects
        </h2>
        <button
          onClick={onAddProject}
          className="bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 text-xs font-mono px-2 py-1 rounded transition-colors flex items-center gap-1 border border-cyan-500/20"
          title="Add repository"
          data-testid="sidebar-add-button"
        >
          <Plus size={11} />
          <span>Add</span>
        </button>
      </div>
      <div className="space-y-3">
        {sortedRepos.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-600 font-mono">
            No projects yet. Add a repo to start reviewing.
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
                  mode="owner"
                  onSelect={() => onSelectRepo(repo.id)}
                  onEdit={() => onEditRepo(repo)}
                  onRepoSettings={() => onRepoSettings(repo)}
                  onMintKey={() => onMintKey({ id: repo.id, name: repo.name })}
                />
                {isRepoSelected && (
                  <PrList
                    prs={prs.filter((pr) => pr.repoId === repo.id)}
                    selectedPrId={selectedPrId}
                    onSelectPr={onSelectPr}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SharedProjectsPane({
  sharedProjects,
  repoReviewStatus,
  yourRepoById,
  selectedRepoId,
  onSelectRepo,
  onMintKey,
  prs,
  selectedPrId,
  onSelectPr,
}: {
  sharedProjects: { id: string; name: string; role: "admin" | "member" | null; invitedAt: string | null }[];
  repoReviewStatus: Map<string, "idle" | "scanning" | "complete" | "failed" | "pending" | "changes">;
  yourRepoById: Map<string, Repository>;
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onMintKey: (repo: { id: string; name: string }) => void;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
}) {
  return (
    <div className="p-4" data-testid="sidebar-shared-section">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-extrabold font-mono">
          Shared with you
        </h2>
        <span className="text-[9px] text-slate-600 font-mono">
          {sharedProjects.length}
        </span>
      </div>
      <div className="space-y-3">
        {sharedProjects.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-600 font-mono">
            Nothing shared with you yet.
          </div>
        ) : (
          sharedProjects.map((sp) => {
            const full = yourRepoById.get(sp.id);
            if (!full) return null;
            const isRepoSelected = selectedRepoId === sp.id;
            return (
              <div key={sp.id} className="space-y-1">
                <RepoRow
                  repo={full}
                  isRepoSelected={isRepoSelected}
                  reviewStatus={repoReviewStatus.get(sp.id) || "idle"}
                  mode="shared"
                  onSelect={() => onSelectRepo(sp.id)}
                  onMintKey={() => onMintKey({ id: full.id, name: full.name })}
                />
                {isRepoSelected && (
                  <PrList
                    prs={prs.filter((pr) => pr.repoId === sp.id)}
                    selectedPrId={selectedPrId}
                    onSelectPr={onSelectPr}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function RepoRow({
  repo,
  isRepoSelected,
  reviewStatus,
  mode,
  onSelect,
  onEdit,
  onRepoSettings,
  onMintKey,
}: {
  repo: Repository;
  isRepoSelected: boolean;
  reviewStatus: string;
  mode: "owner" | "shared";
  onSelect: () => void;
  onEdit?: () => void;
  onRepoSettings?: () => void;
  onMintKey: () => void;
}) {
  const statusCfg = STATUS_CONFIG[reviewStatus] || STATUS_CONFIG.idle;
  const prCount = repo.prCount || 0;
  const isShared = mode === "shared";
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
      data-testid={`sidebar-repo-${repo.id}`}
      data-repo-mode={mode}
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
          {isShared && (
            <span
              className="text-[8px] font-mono font-bold px-1 py-0.2 rounded bg-slate-800 text-slate-400 border border-white/5 shrink-0"
              title="Shared with you"
            >
              <Users size={8} className="inline-block mr-0.5" />
              shared
            </span>
          )}
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
              onMintKey();
            }}
            aria-label={`Mint an API key for ${repo.name}`}
            title="Mint an API key for this repo"
            className="text-slate-500 hover:text-cyan-400 transition-all cursor-pointer"
            data-testid={`sidebar-key-button-${repo.id}`}
          >
            <KeyRound size={12} />
          </button>
          {!isShared && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRepoSettings?.();
                }}
                aria-label={`Repo settings & index stats for ${repo.name}`}
                title="Repo settings & index stats"
                className="text-slate-500 hover:text-cyan-400 transition-all cursor-pointer"
                data-testid={`sidebar-settings-button-${repo.id}`}
              >
                <BarChart3 size={12} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit?.();
                }}
                aria-label={`Edit connection details for ${repo.name}`}
                title="Edit connection details"
                className="text-slate-500 hover:text-cyan-400 transition-all cursor-pointer"
                data-testid={`sidebar-edit-button-${repo.id}`}
              >
                <Settings size={12} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="text-[9px] font-mono text-slate-500 truncate mt-0.5 pl-5">
        {repo.path || repo.cloneUrl || repo.id}
      </div>
    </div>
  );
}
