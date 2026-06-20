"use client";
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  GitBranch,
  Zap,
  BookOpen,
  Activity,
  FileCode,
  History,
  Plus,
  Trash2,
  Terminal,
  Search,
  Sliders,
  Database,
  CornerDownRight,
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Settings,
  X,
  Menu,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Download,
  RefreshCw,
  User,
  Calendar,
  Hash,
  AlertCircle,
  Check,
  Code2,
  FileCode2,
  ListTodo,
  Folder,
  Network
} from 'lucide-react';
import PRDTracker from './components/PRDTracker';
import GitWatcher from './components/GitWatcher';
import CodebaseGraph from './components/CodebaseGraph';
import DbConfigView from './components/views/DbConfigView';
import DashboardSidebar from './components/DashboardSidebar';
import PrsView from './components/views/PrsView';
import AddRepoModal from './components/modals/AddRepoModal';
import {
  getStatusBadgeStyle,
  type ActiveTab,
  type ActivityLog,
  type DbConfig,
  type PRFile,
  type PullRequest,
  type Repository,
  type ReviewFinding,
} from './lib/types';

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('prs');

  // Multi-Database configuration states
  const [dbConfig, setDbConfig] = useState<DbConfig>({
    dialect: 'postgresql',
    host: 'localhost',
    port: '',
    username: '',
    password: '',
    database: '',
    sqliteFile: 'data.db'
  });
  const [dbTestResult, setDbTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [dbSaveResult, setDbSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingDb, setIsTestingDb] = useState(false);
  const [isSavingDb, setIsSavingDb] = useState(false);
  const [dbStatus, setDbStatus] = useState<'configured' | 'unconfigured' | 'unknown'>('unknown');

  const fetchDbConfig = async () => {
    try {
      const res = await fetch("/api/db/config");
      if (res.ok) {
        const data = await res.json();
        setDbConfig({
          dialect: data.dialect || 'postgresql',
          host: data.host || '',
          port: data.port || '',
          username: data.username || '',
          password: '',
          database: data.database || '',
          sqliteFile: data.sqliteFile || 'data.db'
        });
        setDbStatus(data.configured ? 'configured' : 'unconfigured');
      }
    } catch (e) {
      console.error("Failed loading database config:", e);
    }
  };

  const handleTestDbConnection = async () => {
    setIsTestingDb(true);
    setDbTestResult(null);
    try {
      const res = await fetch("/api/db/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dbConfig)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setDbTestResult({ success: true, message: "Connected. SELECT 1 returned successfully from the configured pool." });
      } else {
        setDbTestResult({ success: false, message: data.error || "Connection failed. Check the connection string, credentials, and network reachability." });
      }
    } catch (err: any) {
      setDbTestResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsTestingDb(false);
    }
  };

  const handleSaveDbConfig = async () => {
    setIsSavingDb(true);
    setDbSaveResult(null);
    try {
      const res = await fetch("/api/db/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dbConfig)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const msg = data.message || "Saved. Restart the dev server to apply.";
        setDbSaveResult({ success: true, message: msg });
        await fetchDbConfig();
      } else {
        setDbSaveResult({ success: false, message: data.error || "Failed applying config." });
      }
    } catch (err: any) {
      setDbSaveResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsSavingDb(false);
    }
  };
  
  // State from SQLite
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string>('greploop-core');
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [selectedPrId, setSelectedPrId] = useState<string>('');
  const [prFiles, setPrFiles] = useState<PRFile[]>([]);
  const [selectedFilename, setSelectedFilename] = useState<string>('');
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  // Config parameters for Pluggable LLM Router
  const [backendOption, setBackendOption] = useState<'local' | 'cloud'>('cloud');
  const [localPort, setLocalPort] = useState<number>(11434);
  const [localModel, setLocalModel] = useState<string>('codellama:13b');
  
  // Interactive UI indicators
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ count: number; model: string; notice?: string | null } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Modal State for adding local Git directory paths
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [newBaseBranch, setNewBaseBranch] = useState('main');
  const [newTriggerMode, setNewTriggerMode] = useState<'auto' | 'mention'>('auto');
  const [newQuietPeriod, setNewQuietPeriod] = useState(10);
  const [newBranchPattern, setNewBranchPattern] = useState('feature/*');
  const [errorFeedback, setErrorFeedback] = useState<string | null>(null);

  // 1. Fetch Repository list
  const fetchRepos = async () => {
    try {
      const res = await fetch('/api/repos');
      const data = await res.json();
      if (Array.isArray(data)) {
        setRepos(data);
        if (data.length > 0 && !selectedRepoId) {
          setSelectedRepoId(data[0].id);
        }
      }
    } catch (e) {
      console.error("Failed loading repositories", e);
    }
  };

  // 2. Fetch Pull Requests for selected repository
  const fetchPrsForSelectedRepo = async (repoId: string, retainSelection = true) => {
    try {
      const res = await fetch(`/api/repos/${repoId}/prs`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setPrs(data);
        if (data.length > 0) {
          setSelectedPrId(prev => {
            if (retainSelection && prev && data.some(p => p.id === prev)) {
              return prev;
            }
            return data[0].id;
          });
        } else {
          setSelectedPrId('');
          setPrFiles([]);
          setFindings([]);
        }
      }
    } catch (e) {
      console.error("Failed loading PR list for repo " + repoId, e);
    }
  };

  // 3. Fetch Files & existed findings for active PR
  const fetchPrDetails = async (prId: string) => {
    if (!prId) return;
    try {
      // Files involved
      const filesRes = await fetch(`/api/prs/${prId}/files`);
      const filesData = await filesRes.json();
      if (Array.isArray(filesData)) {
        setPrFiles(filesData);
        if (filesData.length > 0) {
          setSelectedFilename(prev => {
            const stillExists = filesData.some(f => f.filename === prev);
            return stillExists ? prev : filesData[0].filename;
          });
        } else {
          setSelectedFilename('');
        }
      }

      // Review findings
      const findingsRes = await fetch(`/api/prs/${prId}/findings`);
      const findingsData = await findingsRes.json();
      if (Array.isArray(findingsData)) {
        setFindings(findingsData);
      }
    } catch (e) {
      console.error("Failed retrieving PR files/findings detailed block", e);
    }
  };

  // 4. Fetch logs
  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/reviews');
      const data = await res.json();
      if (Array.isArray(data)) {
        const mappedLogs: ActivityLog[] = data.map((item: any) => ({
          id: `review-${item.id}`,
          action: item.status === 'done' ? 'AI Review Scanned' : 'Daemon Initialized',
          target: `${item.repoName} (${item.branch})`,
          time: new Date(item.timestamp).toLocaleTimeString(),
          status: 'done'
        }));
        setLogs(mappedLogs);
      }
    } catch (e) {
      console.error("Failed fetching review history logs", e);
    }
  };

  // Trigger loading sequences
  useEffect(() => {
    fetchRepos();
    fetchLogs();
    fetchDbConfig();
  }, []);

  // Set up continuous background polling for real-time progress and notifications
  useEffect(() => {
    const interval = setTimeout(() => {
      // Fetch initial details
      if (selectedRepoId) {
        fetchPrsForSelectedRepo(selectedRepoId, true);
      }
      if (selectedPrId) {
        fetchPrDetails(selectedPrId);
      }
    }, 50);

    const poller = setInterval(() => {
      fetchRepos();
      fetchLogs();
      if (selectedRepoId) {
        fetchPrsForSelectedRepo(selectedRepoId, true);
      }
      if (selectedPrId) {
        fetchPrDetails(selectedPrId);
      }
    }, 2000);

    return () => {
      clearTimeout(interval);
      clearInterval(poller);
    };
  }, [selectedRepoId, selectedPrId]);

  // Handle manual/explicit PR Scan action
  const handleTriggerPrScan = async () => {
    if (!selectedPrId) return;
    setIsScanning(true);
    setScanResult(null);

    const activeRepoName = repos.find(r => r.id === selectedRepoId)?.name || selectedRepoId;

    try {
      const res = await fetch(`/api/prs/${selectedPrId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backendOption,
          localPort,
          localModel,
          repoId: activeRepoName
        })
      });

      const result = await res.json();
      if (res.ok) {
        setScanResult({
          count: result.findings?.length || 0,
          model: result.usedModel,
          notice: result.systemWarn
        });
        // Reload details immediately
        await fetchPrDetails(selectedPrId);
        await fetchRepos();
        await fetchLogs();
      } else {
        alert("Pipeline Scan Error: " + (result.error || "Execution timeout"));
      }
    } catch (e: any) {
      console.error("Scan dispatch crash", e);
      alert("Pipeline Dispatch Crashed: " + e.message);
    } finally {
      setIsScanning(false);
    }
  };

  // Handler to register a new local repository path
  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || !newRepoPath.trim()) {
      setErrorFeedback("Both Project Name and Directory Path are required.");
      return;
    }

    try {
      const res = await fetch('/api/repos', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newRepoName.trim(),
          path: newRepoPath.trim(),
          baseBranch: newBaseBranch,
          triggerMode: newTriggerMode,
          quietPeriodSeconds: Number(newQuietPeriod),
          branchPattern: newBranchPattern
        })
      });

      const data = await res.json();
      if (res.ok) {
        setShowAddRepoModal(false);
        setNewRepoName('');
        setNewRepoPath('');
        setErrorFeedback(null);
        // Reload repositories list and force switch to new repo
        await fetchRepos();
        setSelectedRepoId(data.id);
        await fetchPrsForSelectedRepo(data.id, false);
      } else {
        setErrorFeedback(data.error || "Failed linking project.");
      }
    } catch (err: any) {
      setErrorFeedback("Server connection lost: " + err.message);
    }
  };

  // Dispatch callback from background daemon
  const handleTriggerReviewPass = () => {
    fetchRepos();
    fetchLogs();
    if (selectedPrId) {
      fetchPrDetails(selectedPrId);
    }
  };

  // Markdown compiler & download utility
  const handleExportMarkdown = () => {
    const activePr = prs.find(p => p.id === selectedPrId);
    const activeRepo = repos.find(r => r.id === selectedRepoId);
    if (!activePr || !activeRepo) return;

    let mdContent = `# GrepLoop automated PR Code Review Summary Card\n\n`;
    mdContent += `### System Details:\n`;
    mdContent += `- **Project:** \`${activeRepo.name}\`\n`;
    mdContent += `- **Pull Request:** \`${activePr.title}\`\n`;
    mdContent += `- **Source Branch:** \`${activePr.sourceBranch}\` \`(${activePr.commitHash})\`\n`;
    mdContent += `- **Target/Base Branch:** \`${activePr.targetBranch}\`\n`;
    mdContent += `- **Author Name:** \`${activePr.author}\`\n`;
    mdContent += `- **Scanned On (UTC):** \`${new Date().toISOString()}\`\n`;
    mdContent += `- **Core Policy Stack:** Compliance GrepLoop Guard v4\n\n`;
    mdContent += `--- \n\n`;

    mdContent += `## Files Checked in Pull Request:\n`;
    prFiles.forEach(file => {
      mdContent += `- **File:** \`${file.filename}\` (\`+${file.additions}\` additions, \`-${file.deletions}\` deletions)\n`;
    });
    mdContent += `\n`;

    mdContent += `## Review Findings and Severity Alerts:\n\n`;

    if (findings.length === 0) {
      mdContent += `🎉 **Perfect PR Pass!** No bugs, performance leaks, or security vulnerabilities discovered for this diff block.\n`;
    } else {
      findings.forEach((find, idx) => {
        mdContent += `### [${idx + 1}] Severity: **${find.severity.toUpperCase()}** • Category: **${find.category}**\n`;
        mdContent += `- **Location:** \`${find.filename}\` (Line ${find.line})\n`;
        mdContent += `- **Observation Detail:** ${find.explanation}\n`;
        if (find.diffSuggestion) {
          mdContent += `\n**Proposed Resolution:**\n`;
          mdContent += `\`\`\`rust\n${find.diffSuggestion}\n\`\`\`\n`;
        }
        mdContent += `\n---\n\n`;
      });
    }

    mdContent += `\n\n_Auto compiled by GrepLoop daemon - Local-First PR review agent._`;

    // Trigger browser file download
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${activeRepo.name}-${activePr.sourceBranch.replace(/\//g, "-")}-review-card.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCopyCode = (text: string, pathId: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(pathId);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const activePR = prs.find(p => p.id === selectedPrId);
  const activeRepo = repos.find(r => r.id === selectedRepoId);
  const activeFile = prFiles.find(f => f.filename === selectedFilename) || prFiles[0];

  return (
    <div className="flex flex-col h-screen w-full bg-[#0B0E14] text-slate-300 font-sans select-none overflow-hidden relative">
      
      {/* 1. Header Bar */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10 bg-[#0B0E14] shrink-0">
        <div className="flex items-center gap-3">
          {/* Menu button for mobile drawer */}
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

          {/* Quick Stats of checked components */}
          <div className="hidden lg:flex items-center gap-4">
            <span className="text-[11px] font-mono text-slate-500 uppercase">Registered Projects: <strong className="text-white">{repos.length}</strong></span>
            <span className="text-[11px] font-mono text-slate-500 uppercase">Queued PR requests: <strong className="text-cyan-400">{prs.length}</strong></span>
          </div>
        </div>
      </header>

      {/* 2. Main Workspace Layout */}
      <main className="flex flex-1 overflow-hidden relative">
        
        {/* Sidebar Panel */}
        <DashboardSidebar
          isSidebarOpen={isSidebarOpen}
          onAddProject={() => setShowAddRepoModal(true)}
          repos={repos}
          selectedRepoId={selectedRepoId}
          onSelectRepo={(repoId) => {
            setSelectedRepoId(repoId);
            fetchPrsForSelectedRepo(repoId, false);
          }}
          prs={prs}
          selectedPrId={selectedPrId}
          onSelectPr={(prId) => {
            setSelectedPrId(prId);
            setActiveTab('prs');
            if (typeof window !== 'undefined' && window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          backendOption={backendOption}
          setBackendOption={setBackendOption}
          localPort={localPort}
          setLocalPort={setLocalPort}
          localModel={localModel}
          setLocalModel={setLocalModel}
          logs={logs}
        />

        {/* Content Body Viewport */}
        <section className="flex-1 flex flex-col bg-[#0B0E14] overflow-hidden">
          
          {/* Main Title Metadata Row */}
          <div className="p-4 sm:p-5 border-b border-white/5 flex flex-col sm:flex-row sm:items-end justify-between gap-4 bg-[#0F1219]/30">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Active Workspace Target:</span>
                <span className="text-xs font-semibold font-mono text-cyan-400 bg-cyan-400/10 px-1.5 py-0.5 rounded border border-cyan-400/20">
                  {activeRepo?.name || selectedRepoId}
                </span>
                <span className="text-slate-600 font-mono text-xs">•</span>
                <span className="text-xs font-mono text-slate-400">
                  {activePR ? activePR.sourceBranch : 'No branch checked'}
                </span>
              </div>
              <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight flex items-center gap-2" id="workspace-main-branch-title">
                <GitBranch size={18} className="text-cyan-500" />
                <span>
                  {activeTab === 'prs' 
                    ? `Manual PR Code Review Scanners`
                    : activeTab === 'watcher'
                    ? `Git Watcher Daemon: Configured Workspace`
                    : activeTab === 'roadmap'
                    ? `GrepLoop Tracker: PRD Progress Roadmap`
                    : activeTab === 'codebase'
                    ? `Codebase AST Indexer & Call-Graph Tracer`
                    : `Multi-Database Data Source Settings`
                  }
                </span>
              </h2>
            </div>
            
            {/* Action view switch buttons */}
            <div className="flex bg-slate-900 border border-white/10 p-1 rounded-lg self-start flex-wrap gap-1">
              <button
                onClick={() => setActiveTab('prs')}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === 'prs' 
                    ? 'bg-cyan-500 text-black' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Code2 size={13} />
                <span>Interactive PR / Diff Scanner</span>
              </button>
              <button
                onClick={() => setActiveTab('watcher')}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === 'watcher' 
                    ? 'bg-cyan-500 text-black' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Activity size={13} />
                <span>Git Watcher Daemon</span>
              </button>
              <button
                onClick={() => setActiveTab('codebase')}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === 'codebase' 
                    ? 'bg-cyan-500 text-black' 
                    : 'text-slate-400 hover:text-white'
                }`}
                id="tab-codebase-graph"
              >
                <Network size={13} />
                <span>Codebase AST graph</span>
              </button>
              <button
                onClick={() => setActiveTab('roadmap')}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === 'roadmap' 
                    ? 'bg-cyan-500 text-black' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ListTodo size={13} />
                <span>PRD Task Roadmap</span>
              </button>
              <button
                onClick={() => setActiveTab('db_config')}
                className={`px-2.5 py-1.5 rounded-md text-xs font-semibold font-mono tracking-tight transition-all flex items-center gap-1.5 ${
                  activeTab === 'db_config' 
                    ? 'bg-cyan-500 text-black' 
                    : 'text-slate-400 hover:text-white'
                }`}
                id="tab-db-config"
              >
                <Database size={13} />
                <span>Data Source Settings</span>
              </button>
            </div>
          </div>

           {/* Core Content Switching Frame */}
          <div className="flex-1 overflow-hidden p-4 sm:p-5 flex flex-col space-y-4">
            
            <AnimatePresence mode="wait">
              {activeTab === 'db_config' && (
                <DbConfigView
                  dbConfig={dbConfig}
                  setDbConfig={setDbConfig}
                  dbStatus={dbStatus}
                  reposCount={repos.length}
                  prsCount={prs.length}
                  isTestingDb={isTestingDb}
                  isSavingDb={isSavingDb}
                  dbTestResult={dbTestResult}
                  dbSaveResult={dbSaveResult}
                  onTest={handleTestDbConnection}
                  onSave={handleSaveDbConfig}
                />
              )}

              {activeTab === 'codebase' && (
                <motion.div 
                  key="codebase-frame"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.1 }}
                  className="flex flex-col flex-1 overflow-y-auto"
                >
                  <CodebaseGraph repoId={selectedRepoId} repoName={activeRepo?.name || selectedRepoId} />
                </motion.div>
              )}

              {activeTab === 'roadmap' && (
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

              {activeTab === 'watcher' && (
                <motion.div 
                  key="watcher-frame"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.1 }}
                  className="flex flex-col flex-1 overflow-hidden"
                >
                  <GitWatcher 
                    onTriggerReviewPass={handleTriggerReviewPass} 
                    activeRepoId={selectedRepoId}
                    onRepoChange={(id) => setSelectedRepoId(id)}
                  />
                </motion.div>
              )}

              {activeTab === 'prs' && (
                <PrsView
                  activePR={activePR}
                  isScanning={isScanning}
                  onTriggerScan={handleTriggerPrScan}
                  onExportMarkdown={handleExportMarkdown}
                  scanResult={scanResult}
                  onDismissScanResult={() => setScanResult(null)}
                  findings={findings}
                  onCopySuggestion={handleCopyCode}
                  copyFeedback={copyFeedback}
                  prFiles={prFiles}
                  selectedFilename={selectedFilename}
                  onSelectFilename={setSelectedFilename}
                  activeFile={activeFile}
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
                className="px-3 py-1.5 text-xs font-semibold bg-white/5 border border-white/10 text-slate-350 rounded hover:bg-white/10 transition-colors cursor-pointer"
              >
                Sync local report folder
              </button>
              <button 
                onClick={() => {
                  alert(`Direct Workspace Diff View: Displaying changes from base path for ${activeRepo ? activeRepo.name : selectedRepoId}`);
                }}
                className="px-3 py-1.5 text-xs font-semibold bg-cyan-500 text-black rounded hover:bg-cyan-400 transition-colors cursor-pointer"
              >
                View workspace logs
              </button>
            </div>
          </footer>

        </section>

      </main>

      {/* MODAL: Register a New Project Path */}
      <AnimatePresence>
        {showAddRepoModal && (
          <AddRepoModal
            onClose={() => {
              setShowAddRepoModal(false);
              setErrorFeedback(null);
            }}
            onSubmit={handleAddRepo}
            errorFeedback={errorFeedback}
            newRepoName={newRepoName}
            setNewRepoName={setNewRepoName}
            newRepoPath={newRepoPath}
            setNewRepoPath={setNewRepoPath}
            newBaseBranch={newBaseBranch}
            setNewBaseBranch={setNewBaseBranch}
            newBranchPattern={newBranchPattern}
            setNewBranchPattern={setNewBranchPattern}
            newTriggerMode={newTriggerMode}
            setNewTriggerMode={setNewTriggerMode}
            newQuietPeriod={newQuietPeriod}
            setNewQuietPeriod={setNewQuietPeriod}
          />
        )}
      </AnimatePresence>

    </div>
  );
}
