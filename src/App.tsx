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
} from "lucide-react";
import PRDTracker from "./components/PRDTracker";
import GitWatcher from "./components/GitWatcher";
import CodebaseGraph from "./components/CodebaseGraph";
import DbConfigView from "./components/views/DbConfigView";
import LlmConfigView from "./components/views/LlmConfigView";
import DashboardSidebar from "./components/DashboardSidebar";
import PrsView from "./components/views/PrsView";
import AddRepoModal from "./components/modals/addRepo";
import EditRepoModal from "./components/modals/editRepo";
import RepoSettingsModal from "./components/modals/repoSettings/RepoSettingsModal";
import WebhookPrompt from "./components/modals/addRepo/WebhookPrompt";
import { useDashboardData } from "./hooks/useDashboardData";
import { useEditRepo } from "./hooks/useEditRepo";
import { type ActiveTab, type Repository } from "./lib/types";

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>("prs");
  const [pendingWebhook, setPendingWebhook] = useState<{ repoId: string; repoName: string; hasPat: boolean } | null>(null);
  const [settingsRepo, setSettingsRepo] = useState<Repository | null>(null);

  const d = useDashboardData();
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

  const activeAPR = d.prs.find((p) => p.id === d.selectedPrId);
  const activeRepo = d.repos.find((r) => r.id === d.selectedRepoId);
  const activeFile = d.prFiles.find((f) => f.filename === d.selectedFilename) || d.prFiles[0];

  return (
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

          <div className="w-8 h-8 bg-cyan-500 rounded flex items-center justify-center text-black font-extrabold tracking-tighter" id="brand-logo-badge">
            GL
          </div>

          <div className="flex items-baseline gap-2">
            <h1 className="text-base sm:text-lg font-bold text-white tracking-tight" id="main-title-header">
              GrepLoop
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

      {/* 2. Main Workspace Layout */}
      <main className="flex flex-1 overflow-hidden relative">
        {/* Sidebar Panel */}
        <DashboardSidebar
          isSidebarOpen={isSidebarOpen}
          onAddProject={() => d.setShowAddRepoModal(true)}
          repos={d.repos}
          selectedRepoId={d.selectedRepoId}
          onSelectRepo={(repoId) => {
            d.setSelectedRepoId(repoId);
            d.fetchPrsForSelectedRepo(repoId, false);
          }}
          onEditRepo={(repo) => ed.openEditor(repo)}
          onRepoSettings={(repo) => setSettingsRepo(repo)}
          prs={d.prs}
          selectedPrId={d.selectedPrId}
          onSelectPr={(prId) => {
            d.setSelectedPrId(prId);
            setActiveTab("prs");
            if (typeof window !== "undefined" && window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          onOpenLlmSettings={() => setActiveTab("llm_config")}
          logs={d.logs}
        />

        {/* Content Body Viewport */}
        <section className="flex-1 flex flex-col bg-[#0B0E14] overflow-hidden">
          {/* Main Title Metadata Row */}
          <div className="p-4 sm:p-5 border-b border-white/5 flex flex-col sm:flex-row sm:items-end justify-between gap-4 bg-[#0F1219]/30">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Active Workspace Target:</span>
                <span className="text-xs font-semibold font-mono text-cyan-400 bg-cyan-400/10 px-1.5 py-0.5 rounded border border-cyan-400/20">
                  {activeRepo?.name || d.selectedRepoId}
                </span>
                <span className="text-slate-600 font-mono text-xs">•</span>
                <span className="text-xs font-mono text-slate-400">
                  {activeAPR ? activeAPR.sourceBranch : "No branch checked"}
                </span>
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight flex items-center gap-2" id="workspace-main-branch-title">
                <GitBranch size={18} className="text-cyan-500" />
                <span>
                  {activeTab === "prs"
                    ? `Manual PR Code Review Scanners`
                    : activeTab === "watcher"
                    ? `Git Watcher Daemon: Configured Workspace`
                    : activeTab === "roadmap"
                    ? `GrepLoop Tracker: PRD Progress Roadmap`
                    : activeTab === "codebase"
                    ? `Codebase AST Indexer & Call-Graph Tracer`
                    : activeTab === "llm_config"
                    ? `LLM Router Configuration`
                    : `Multi-Database Data Source Settings`}
                </span>
              </h2>
            </div>

            {/* Action view switch buttons */}
            <div className="flex bg-slate-900 border border-white/10 p-1 rounded-lg self-start flex-wrap gap-1">
              <button
                onClick={() => setActiveTab("prs")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "prs" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                <Code2 size={13} />
                <span>Interactive PR / Diff Scanner</span>
              </button>
              <button
                onClick={() => setActiveTab("watcher")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "watcher" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                <Activity size={13} />
                <span>Git Watcher Daemon</span>
              </button>
              <button
                onClick={() => setActiveTab("codebase")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "codebase" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
                id="tab-codebase-graph"
              >
                <Network size={13} />
                <span>Codebase AST graph</span>
              </button>
              <button
                onClick={() => setActiveTab("roadmap")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "roadmap" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
              >
                <ListTodo size={13} />
                <span>PRD Task Roadmap</span>
              </button>
              <button
                onClick={() => setActiveTab("db_config")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "db_config" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
                id="tab-db-config"
              >
                <Database size={13} />
                <span>Data Source Settings</span>
              </button>
              <button
                onClick={() => setActiveTab("llm_config")}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === "llm_config" ? "bg-cyan-500 text-black" : "text-slate-400 hover:text-white"
                }`}
                id="tab-llm-config"
              >
                <Cpu size={13} />
                <span>Settings</span>
              </button>
            </div>
          </div>

          {/* Core Content Switching Frame */}
          <div className="flex-1 overflow-hidden p-4 sm:p-5 flex flex-col space-y-4">
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
                    repoId={d.selectedRepoId}
                    repoName={activeRepo?.name || d.selectedRepoId}
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
                    activeRepoId={d.selectedRepoId}
                    onRepoChange={(id) => d.setSelectedRepoId(id)}
                  />
                </motion.div>
              )}

              {activeTab === "prs" && (
                <PrsView
                  activePR={activeAPR}
                  isScanning={d.isScanning}
                  onTriggerScan={d.handleTriggerPrScan}
                  onExportMarkdown={d.handleExportMarkdown}
                  scanResult={d.scanResult}
                  onDismissScanResult={() => d.setScanResult(null)}
                  findings={d.findings}
                  onCopySuggestion={d.handleCopyCode}
                  copyFeedback={d.copyFeedback}
                  prFiles={d.prFiles}
                  selectedFilename={d.selectedFilename}
                  onSelectFilename={d.setSelectedFilename}
                  activeFile={activeFile}
                  repoIndexedAt={activeRepo?.indexedAt ?? null}
                  repoId={d.selectedRepoId}
                  onIndexComplete={d.handleTriggerReviewPass}
                />
              )}
            </AnimatePresence>
          </div>

          {/* High-Tech Terminal Footer / Statistics Row */}
          <footer className="p-4 border-t border-white/5 bg-[#0F1219] flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex gap-4 text-[10px] text-slate-500 uppercase font-mono">
              <span>ACTIVE PIPELINE: <strong className="text-[#10b981] animate-pulse">daemon.listener</strong></span>
              <span>COMPLIANCE POLICY: <strong className="text-indigo-400">Sleek GrepLoop compliance v1.6.2</strong></span>
              <span>SQLite Cache Status: <strong className="text-cyan-400">Online</strong></span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  alert("Local Export: Reports synced under '~/.greploop/reports/...' data catalog.");
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-white/5 border border-white/10 text-slate-300 rounded hover:bg-white/10 transition-colors cursor-pointer"
              >
                Sync local report folder
              </button>
              <button
                onClick={() => {
                  alert(`Direct Workspace Diff View: Displaying changes from base path for ${activeRepo ? activeRepo.name : d.selectedRepoId}`);
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
              d.setErrorFeedback(null);
            }}
            onSubmit={d.handleAddRepo}
            errorFeedback={d.errorFeedback}
            newRepoName={d.newRepoName}
            setNewRepoName={d.setNewRepoName}
            newRepoPath={d.newRepoPath}
            setNewRepoPath={d.setNewRepoPath}
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
            newRepoPath={ed.editPath}
            setNewRepoPath={ed.setEditPath}
            newCloneUrl={ed.editCloneUrl}
            setNewCloneUrl={ed.setEditCloneUrl}
            newCloneUrlHttps={ed.editCloneUrlHttps}
            setNewCloneUrlHttps={ed.setEditCloneUrlHttps}
            newDeployKey={ed.editDeployKey}
            setNewDeployKey={ed.setEditDeployKey}
            newPat={ed.editPat}
            setNewPat={ed.setEditPat}
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
              // Poll for completion
              const deadline = Date.now() + 15 * 60 * 1000;
              while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 5000));
                const poll = await fetch(`/api/repos/${repoId}`);
                if (poll.ok) {
                  const repo = await poll.json();
                  if (repo?.indexedAt) {
                    return;
                  }
                }
              }
            }}
            onRefresh={async () => {
              d.handleTriggerReviewPass();
              if (d.selectedRepoId) {
                await d.fetchPrsForSelectedRepo(d.selectedRepoId, true);
              }
              setSettingsRepo(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
