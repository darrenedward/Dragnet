"use client";
import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  GitBranch,
  Activity,
  Network,
  X,
  Menu,
  Database,
  Code2,
  ListTodo,
  Cpu,
  Users,
} from "lucide-react";
import PRDTracker from "./components/PRDTracker";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";
import { toast } from "./lib/toast";
import GitWatcher from "./components/GitWatcher";
import CodebaseGraph from "./components/CodebaseGraph";
import DbConfigView from "./components/views/DbConfigView";
import LlmConfigView from "./components/views/LlmConfigView";
import DashboardSidebar from "./components/DashboardSidebar";
import SystemSetupBanner from "./components/SystemSetupBanner";
import PrsView from "./components/views/PrsView";
import TrivialSkipNotice from "./components/views/prs/TrivialSkipNotice";
import AddRepoModal from "./components/modals/addRepo";
import EditRepoModal from "./components/modals/editRepo";
import RepoSettingsModal from "./components/modals/repoSettings/RepoSettingsModal";
import WebhookPrompt from "./components/modals/addRepo/WebhookPrompt";
import TeamPanel from "./components/views/team/TeamPanel";
import ScanQueueView from "./components/views/ScanQueueView";
import RepoKeyModal from "./components/modals/repoKey/RepoKeyModal";
import FirstKeyPrompt from "./components/FirstKeyPrompt";
import DashboardTitleBar from "./components/DashboardTitleBar";
import { useDashboardData } from "./hooks/useDashboardData";
import { useEditRepo } from "./hooks/useEditRepo";
import { fetchJson } from "./lib/http";
import { authClient } from "./lib/auth-client";
import { type ActiveTab, type ConfigHealthReport, type Repository } from "./lib/types";

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>("prs");
  const [pendingWebhook, setPendingWebhook] = useState<{ repoId: string; repoName: string; hasPat: boolean } | null>(null);
  const [settingsRepo, setSettingsRepo] = useState<Repository | null>(null);
  const [configHealth, setConfigHealth] = useState<ConfigHealthReport | null>(null);
  const [keyModalRepo, setKeyModalRepo] = useState<{ id: string; name: string } | null>(null);
  const { data: sessionData } = authClient.useSession();
  const currentUserId = (sessionData?.user as { id?: string } | undefined)?.id ?? null;

  const d = useDashboardData();
  const { readModel: workspace, commands: workspaceCommands } = d.workspace;
  const ed = useEditRepo({
    onUpdated: async () => {
      await d.fetchPrsForSelectedRepo(d.selectedRepoId, true);
    },
    onWebhookPrompt: ({ id, name, hasPat }) => {
      setPendingWebhook({ repoId: id, repoName: name, hasPat });
    },
  });

  useEffect(() => {
    if (d.lastRegisteredRepo) {
      setPendingWebhook({ repoId: d.lastRegisteredRepo.id, repoName: d.lastRegisteredRepo.name, hasPat: d.lastRegisteredRepo.hasPat });
      d.setLastRegisteredRepo(null);
    }
  }, [d.lastRegisteredRepo]);

  const fetchConfigHealth = async () => {
    try {
      const res = await fetchJson("/api/config/health");
      if (res.ok) setConfigHealth(await res.json());
    } catch (err) {
      console.error("Failed loading configuration health:", err);
    }
  };

  const saveCurrentPublicUrl = async () => {
    try {
      const url = `${window.location.origin}`;
      const res = await fetchJson("/api/config/public-url", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Unable to save server address.");
      await fetchConfigHealth();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to save server address.");
    }
  };

  useEffect(() => {
    fetchConfigHealth();
  }, []);

  const activeRepo = workspace.selectedRepository;
  const activeAPR = workspace.selectedPullRequest;
  const activeFile = workspace.activeFile;

  return (
    <ErrorBoundary>
    <div className="flex flex-col h-screen w-full bg-[#0B0E14] text-slate-300 font-sans select-none overflow-hidden relative">
      {/* 1. Header Bar */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10 bg-[#0B0E14] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-1 hover:bg-white/5 rounded-lg text-slate-400 transition-colors md:hidden"
            aria-label="Toggle Sidebar Menu"
            id="sidebar-toggle-btn"
          >
            {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className="w-8 h-8 bg-cyan-500 rounded flex items-center justify-center text-black font-extrabold tracking-tighter text-xs" id="brand-logo-badge">
            DN
          </div>

          <div className="flex items-baseline gap-2">
            <h1 className="text-base sm:text-lg font-bold text-white tracking-tight" id="main-title-header">
              Dragnet
            </h1>
            <span className="text-[10px] font-mono text-cyan-500 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20 font-bold uppercase tracking-widest hidden sm:inline">
              automated PR agent
            </span>
          </div>
        </div>

        {/* Header Right Widgets */}
        <div className="flex items-center gap-4 sm:gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981] animate-pulse" />
            <span className="text-[10px] sm:text-xs font-mono uppercase text-slate-400 tracking-wider">
              PR-Daemon: Active
            </span>
          </div>

          <div className="h-4 w-px bg-white/10 hidden sm:block" />

          <div className="hidden lg:flex items-center gap-4">
            <span className="text-[11px] font-mono text-slate-500 uppercase">Registered Projects: <strong className="text-white">{d.repos.length}</strong></span>
            <span className="text-[11px] font-mono text-slate-500 uppercase">Queued PR requests: <strong className="text-cyan-400">{d.prs.length}</strong></span>
          </div>
        </div>
      </header>

      <SystemSetupBanner
        health={configHealth}
        onOpenDbSettings={() => setActiveTab("db_config")}
        onOpenSettings={() => setActiveTab("llm_config")}
        onRefresh={fetchConfigHealth}
        onUseCurrentUrl={saveCurrentPublicUrl}
      />

      {/* 2. Main Workspace Layout */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar Panel */}
        <DashboardSidebar
          isSidebarOpen={isSidebarOpen}
          onAddProject={() => d.setShowAddRepoModal(true)}
          repos={d.repos}
          selectedRepoId={workspace.selectedRepoId}
          onSelectRepo={(repoId) => {
            workspaceCommands.selectRepository(repoId);
            d.fetchPrsForSelectedRepo(repoId, false);
          }}
          onEditRepo={(repo) => ed.openEditor(repo)}
          onRepoSettings={(repo) => setSettingsRepo(repo)}
          onMintKey={(repo) => setKeyModalRepo(repo)}
          currentUserId={currentUserId}
          prs={d.prs}
          selectedPrId={workspace.selectedPrId}
          onSelectPr={(prId) => {
            workspaceCommands.selectPullRequest(prId);
            setActiveTab("prs");
            if (typeof window !== "undefined" && window.innerWidth < 768) setIsSidebarOpen(false);
          }}
        />

        {/* Content Body Viewport */}
        <section className="flex-1 flex flex-col bg-[#0B0E14] overflow-hidden min-h-0">
          <DashboardTitleBar
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            activeRepo={activeRepo}
            selectedRepoId={workspace.selectedRepoId}
          />

          {/* Core Content Switching Frame */}
          <div className="flex-1 overflow-hidden p-4 sm:p-5 flex flex-col space-y-4 min-h-0">
            <FirstKeyPrompt onOpenKeys={() => setActiveTab("llm_config")} />
            <AnimatePresence mode="wait">
              {activeTab === "db_config" && (
                <DbConfigView
                  dbConfig={d.dbConfig}
                  setDbConfig={d.setDbConfig}
                  dbStatus={d.dbStatus}
                  reposCount={d.repos.length}
                  prsCount={d.prs.length}
                  isTestingDb={d.isTestingDb}
                  isSavingDb={d.isSavingDb}
                  dbTestResult={d.dbTestResult}
                  dbSaveResult={d.dbSaveResult}
                  onTest={d.handleTestDbConnection}
                  onSave={d.handleSaveDbConfig}
                />
              )}

              {activeTab === "llm_config" && <LlmConfigView />}

              {activeTab === "queue" && <ScanQueueView />}

               {activeTab === "team" && <TeamPanel />}

              {activeTab === "codebase" && (
                <motion.div
                  key="codebase-frame"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.1 }}
                  className="flex flex-col flex-1 overflow-y-auto"
                >
                  <CodebaseGraph
                    repoId={workspace.selectedRepoId}
                    repoName={activeRepo?.name || workspace.selectedRepoId}
                    onIndexComplete={d.handleTriggerReviewPass}
                  />
                </motion.div>
              )}

              {activeTab === "roadmap" && (
                <motion.div
                  key="roadmap-frame"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.1 }}
                  className="flex flex-col flex-1 overflow-y-auto"
                >
                  <PRDTracker />
                </motion.div>
              )}

              {activeTab === "watcher" && (
                <motion.div
                  key="watcher-frame"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.1 }}
                  className="flex flex-col flex-1 overflow-hidden"
                >
                  <GitWatcher
                    onTriggerReviewPass={d.handleTriggerReviewPass}
                    activeRepoId={workspace.selectedRepoId}
                    onRepoChange={workspaceCommands.selectRepository}
                  />
                </motion.div>
              )}

              {activeTab === "prs" && (
                <PrsView
                  activePR={workspace.selectedPullRequest}
                  isScanning={workspace.progress.isScanning}
                  onTriggerScan={workspaceCommands.startScan}
                  onStopScan={workspaceCommands.stopScan}
                  onExportMarkdown={workspaceCommands.exportReview}
                  exportStatus={workspace.feedback.exportStatus}
                  scanResult={workspace.feedback.scanResult}
                  onDismissScanResult={workspaceCommands.dismissScanResult}
                  findings={workspace.findings}
                  reviewRun={workspace.reviewRun}
                  chunks={workspace.reviewChunks}
                  activeScan={workspace.activeScan}
                  queueJob={workspace.queueJob}
                  activeChunks={workspace.activeScanChunks}
                  activeFindings={workspace.activeFindings}
                  activeIterations={workspace.activeIterations}
                  isRetryingChunks={workspace.progress.isRetryingChunks}
                  onRetryFailedChunks={workspaceCommands.retryFailedChunks}
                  stability={workspace.stability}
                  rejectedCount={workspace.rejectedCount}
                  rejectedFindings={workspace.rejectedFindings}
                  stale={workspace.stale}
                  onCopySuggestion={workspaceCommands.copySuggestion}
                  copyFeedback={workspace.feedback.copyFeedback}
                  prFiles={workspace.files}
                  selectedFilename={workspace.selectedFilename}
                  onSelectFilename={workspaceCommands.selectFile}
                  activeFile={workspace.activeFile}
                  repoIndexedAt={workspace.repoIndexedAt}
                  repoId={workspace.selectedRepoId}
                  onIndexComplete={d.handleTriggerReviewPass}
                  interruptedScan={workspace.interruptedScan}
                  onContinueScan={workspaceCommands.continueScan}
                  onStartFreshScan={workspaceCommands.startFreshScan}
                />
              )}
            </AnimatePresence>
          </div>

          {/* High-Tech Terminal Footer / Statistics Row */}
          <footer className="p-4 border-t border-white/5 bg-[#0F1219] flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex gap-4 text-[10px] text-slate-500 uppercase font-mono">
              <span>ACTIVE PIPELINE: <strong className="text-[#10b981] animate-pulse">daemon.listener</strong></span>
              <span>COMPLIANCE POLICY: <strong className="text-indigo-400">Sleek Dragnet compliance v1.6.2</strong></span>
              <span>PostgreSQL Status: <strong className="text-cyan-400">Configured</strong></span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  toast.info(`Direct Workspace Diff View: showing changes from base path for ${activeRepo ? activeRepo.name : workspace.selectedRepoId}`);
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-cyan-500 text-black rounded hover:bg-cyan-400 transition-colors cursor-pointer"
              >
                View workspace logs
              </button>
            </div>
          </footer>
        </section>
      </main>

      {/* MODAL: Post-registration webhook prompt */}
      {pendingWebhook && (
        <WebhookPrompt
          repoName={pendingWebhook.repoName}
          repoId={pendingWebhook.repoId}
          hasPat={pendingWebhook.hasPat}
          onClose={() => setPendingWebhook(null)}
        />
      )}

      {/* MODAL: Register a New Project Path */}
      <AnimatePresence>
        {d.showAddRepoModal && (
          <AddRepoModal
            onClose={() => {
              d.setShowAddRepoModal(false);
              d.setCreatedApiKey(null);
              d.setErrorFeedback(null);
              d.setAddRepoSuccess(null);
            }}
            onSubmit={d.handleAddRepo}
            errorFeedback={d.errorFeedback}
            createdApiKey={d.createdApiKey}
            newRepoName={d.newRepoName}
            setNewRepoName={d.setNewRepoName}
            newBaseBranch={d.newBaseBranch}
            setNewBaseBranch={d.setNewBaseBranch}
            newBranchPattern={d.newBranchPattern}
            setNewBranchPattern={d.setNewBranchPattern}
            newTriggerMode={d.newTriggerMode}
            setNewTriggerMode={d.setNewTriggerMode}
            newQuietPeriod={d.newQuietPeriod}
            setNewQuietPeriod={d.setNewQuietPeriod}
            newRepoMode={d.newRepoMode}
            setNewRepoMode={d.setNewRepoMode}
            newCloneUrl={d.newCloneUrl}
            setNewCloneUrl={d.setNewCloneUrl}
            newCloneUrlHttps={d.newCloneUrlHttps}
            setNewCloneUrlHttps={d.setNewCloneUrlHttps}
            newDeployKey={d.newDeployKey}
            setNewDeployKey={d.setNewDeployKey}
            newPat={d.newPat}
            setNewPat={d.setNewPat}
            newGithubRepoId={d.newGithubRepoId}
            setNewGithubRepoId={d.setNewGithubRepoId}
            addRepoSuccess={d.addRepoSuccess}
            setAddRepoSuccess={d.setAddRepoSuccess}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Edit Existing Project */}
      <AnimatePresence>
        {ed.showEditRepoModal && ed.editingRepo && (
          <EditRepoModal
            repo={ed.editingRepo}
            onClose={ed.closeEditor}
            onSubmit={ed.handleEditRepo}
            errorFeedback={ed.editErrorFeedback}
            newRepoMode={ed.editMode}
            setNewRepoMode={ed.setEditMode}
            newCloneUrl={ed.editCloneUrl}
            setNewCloneUrl={ed.setEditCloneUrl}
            newCloneUrlHttps={ed.editCloneUrlHttps}
            setNewCloneUrlHttps={ed.setEditCloneUrlHttps}
            newDeployKey={ed.editDeployKey}
            setNewDeployKey={ed.setEditDeployKey}
            newPat={ed.editPat}
            setNewPat={ed.setEditPat}
            webhookEnabled={ed.editWebhookEnabled}
            onWebhookEnabledChange={ed.setEditWebhookEnabled}
            editSkipTier2={ed.editSkipTier2}
            setEditSkipTier2={ed.setEditSkipTier2}
            editHostedMode={ed.editHostedMode}
            setEditHostedMode={ed.setEditHostedMode}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Repo Settings (index stats + destructive reset) */}
      <AnimatePresence>
        {settingsRepo && (
          <RepoSettingsModal
            repo={settingsRepo}
            onClose={() => setSettingsRepo(null)}
            onResetIndex={async (repoId) => {
              const res = await fetch(`/api/repos/${repoId}/reindex`, { method: "POST" });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.message || `Reset failed (${res.status})`);
              }
            }}
            onRefresh={async () => {
              d.handleTriggerReviewPass();
              if (d.selectedRepoId) {
                await d.fetchPrsForSelectedRepo(d.selectedRepoId, true);
              }
            }}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Per-repo API key mint (extracted from MyReposView for #69) */}
      <AnimatePresence>
        {keyModalRepo && (
          <RepoKeyModal
            repoId={keyModalRepo.id}
            repoName={keyModalRepo.name}
            onClose={() => setKeyModalRepo(null)}
          />
        )}
      </AnimatePresence>

      {/* MODAL: Trivial-skip results popup. Triggered when runPrScan
          returned usedModel="none (skipped)" — surface the explanation
          the user asked for with a per-browser opt-out. Render-gated
          on prId === selectedPrId as defense-in-depth against cross-PR
          state leaks (the source of truth is the clear in the
          [selectedRepoId, selectedPrId] effect in useDashboardData). */}
      <AnimatePresence>
        {workspace.feedback.trivialSkipNotice && workspace.feedback.trivialSkipNotice.prId === workspace.selectedPrId && (
          <TrivialSkipNotice
            open
            lastRating={workspace.feedback.trivialSkipNotice.lastRating}
            lastScanAt={workspace.feedback.trivialSkipNotice.lastScanAt}
            onClose={workspaceCommands.dismissTrivialSkipNotice}
          />
        )}
      </AnimatePresence>
    </div>
    <Toaster />
    </ErrorBoundary>
  );
}
