"use client";

import { useEffect, useState } from "react";
import type { LlmPresetsState, PullRequest, Repository } from "../lib/types";
import { splitSidebarRepos, type SidebarUserRepo } from "../lib/sidebarFilters";
import { fetchJson } from "../lib/http";
import { ProjectsSidebar } from "./sidebar/ProjectsSidebar";
import { GithubConnectionPane, LlmRouterPane } from "./sidebar/UtilityPanes";

interface Props {
  isSidebarOpen: boolean;
  onAddProject: () => void;
  repos: Repository[];
  selectedRepoId: string;
  onSelectRepo: (repoId: string) => void;
  onEditRepo: (repo: Repository) => void;
  onRepoSettings: (repo: Repository) => void;
  onMintKey: (repo: { id: string; name: string }) => void;
  currentUserId: string | null;
  prs: PullRequest[];
  selectedPrId: string;
  onSelectPr: (prId: string) => void;
  onOpenLlmSettings: () => void;
}

/**
 * Dashboard sidebar (#69 PR 3). Splits the projects list into
 * "Your projects" (filter by Repository.ownerId === currentUserId)
 * and "Shared with you" (filter by UserRepo rows where
 * userId === currentUserId AND Repository.ownerId !== currentUserId).
 *
 * Pure split logic lives in src/lib/sidebarFilters.ts and is
 * exhaustively tested in tests/sidebarFilters.test.ts. The pane
 * components and the row rendering live under src/components/sidebar/
 * to keep this top-level file small.
 */
export default function DashboardSidebar({
  isSidebarOpen,
  onAddProject,
  repos,
  selectedRepoId,
  onSelectRepo,
  onEditRepo,
  onRepoSettings,
  onMintKey,
  currentUserId,
  prs,
  selectedPrId,
  onSelectPr,
  onOpenLlmSettings,
}: Props) {
  const [llmPresets, setLlmPresets] = useState<LlmPresetsState | null>(null);
  const [userRepos, setUserRepos] = useState<SidebarUserRepo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchLlmPresets = async () => {
      try {
        const res = await fetchJson("/api/llm/presets");
        if (!cancelled && res.ok) setLlmPresets(await res.json());
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

  useEffect(() => {
    if (!currentUserId) {
      setUserRepos([]);
      return;
    }
    let cancelled = false;
    const fetchUserRepos = async () => {
      try {
        const res = await fetchJson("/api/user/repos");
        if (!cancelled && res.ok) {
          const data: SidebarUserRepo[] = await res.json();
          setUserRepos(
            data.map((ur) => ({
              userId: ur.userId,
              repoId: ur.repoId,
              role: ur.role === "admin" ? "admin" : "member",
              invitedAt: ur.invitedAt,
            })),
          );
        }
      } catch {
        // silently leave empty — sidebar still renders Your projects from ownerId
      }
    };
    fetchUserRepos();
    const poller = setInterval(fetchUserRepos, 15000);
    return () => {
      cancelled = true;
      clearInterval(poller);
    };
  }, [currentUserId]);

  return (
    <aside
      className={`
        absolute md:relative inset-y-0 left-0 transform ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        md:translate-x-0 transition-transform duration-200 ease-in-out
        w-72 border-r border-white/10 bg-[#0F1219] flex flex-col z-30 shrink-0 select-none
      `}
      id="sidebar-panel-container"
    >
      <ProjectsSidebar
        repos={repos}
        userRepos={userRepos}
        currentUserId={currentUserId}
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

      <GithubConnectionPane />
      <LlmRouterPane state={llmPresets} onOpenSettings={onOpenLlmSettings} />
    </aside>
  );
}
