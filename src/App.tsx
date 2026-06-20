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
    mdContent += `- **Core Policy Stack:** Compliance Woodhill Guard v4\n\n`;
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
        <aside className={`
          absolute md:relative inset-y-0 left-0 transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0 transition-transform duration-200 ease-in-out
          w-72 border-r border-white/10 bg-[#0F1219] flex flex-col z-30 shrink-0 select-none
        `} id="sidebar-panel-container">
                 {/* Unified Projects & PRs Tree View */}
          <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
            <div className="p-4 border-b border-white/5 shrink-0">
              <div className="flex items-center justify-between">
                <h2 className="text-[10px] uppercase tracking-[0.2em] text-cyan-400 font-extrabold font-mono">Workspace Projects</h2>
                <button 
                  onClick={() => setShowAddRepoModal(true)}
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
                      {/* Project Row */}
                      <button
                        onClick={() => {
                          setSelectedRepoId(repo.id);
                          fetchPrsForSelectedRepo(repo.id, false);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg transition-all border ${
                          isRepoSelected 
                            ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400 shadow-[inset_0_1px_5px_rgba(6,182,212,0.05)]' 
                            : 'border-transparent hover:bg-white/5 text-slate-400 hover:text-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <Folder size={13} className={isRepoSelected ? "text-cyan-400" : "text-slate-500"} />
                            <span className="text-xs font-bold tracking-tight truncate font-mono">{repo.name}</span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[8px] font-mono px-1 rounded bg-slate-800 text-slate-400 font-bold">{repo.triggerMode}</span>
                            <span className={`text-[9px] font-mono font-extrabold px-1.5 py-0.2 rounded-full leading-tight ${
                              (repo.prCount || 0) > 0 
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' 
                                : 'bg-slate-900 text-slate-600 border border-transparent'
                            }`}>
                              {repo.prCount || 0}
                            </span>
                          </div>
                        </div>
                        <div className="text-[9px] font-mono text-slate-500 truncate mt-0.5 pl-5">{repo.path}</div>
                      </button>

                      {/* Nested PR Branches inside the active workspace project */}
                      {isRepoSelected && (
                        <div className="pl-3 py-1 space-y-1.5 border-l border-cyan-500/20 ml-4.5 mt-1 animate-fadeIn">
                          {prs.length === 0 ? (
                            <div className="py-2 text-left text-[10px] text-slate-600 font-mono italic pl-2">
                              No detected active PRs
                            </div>
                          ) : (
                            prs.map((pr) => {
                              const isPrSelected = selectedPrId === pr.id;
                              return (
                                <button
                                  key={pr.id}
                                  onClick={() => {
                                    setSelectedPrId(pr.id);
                                    setActiveTab('prs');
                                    if (window.innerWidth < 768) setIsSidebarOpen(false);
                                  }}
                                  className={`w-full text-left p-2 rounded-lg transition-all flex items-start gap-2 border ${
                                    isPrSelected 
                                      ? 'bg-indigo-500/10 border-indigo-500/30 text-white' 
                                      : 'bg-transparent border-transparent hover:bg-white/5 text-slate-400 hover:text-white'
                                  }`}
                                >
                                  <div className={`p-1 mt-0.5 rounded shrink-0 ${isPrSelected ? 'bg-indigo-600/90 text-white' : 'bg-slate-800 text-slate-500'}`}>
                                    <GitBranch size={10} />
                                  </div>
                                  <div className="flex-1 min-w-0 font-mono">
                                    <div className="text-[11px] font-bold truncate text-slate-205">{pr.title}</div>
                                    <div className="flex items-center justify-between mt-0.5 text-[9px] text-slate-500">
                                      <span className="truncate max-w-[90px] text-cyan-400 font-semibold">{pr.sourceBranch}</span>
                                      <div className="flex items-center gap-1 shrink-0">
                                        {pr.rating !== undefined && pr.rating !== null && (
                                          <span className={`px-1 py-0.2 rounded font-extrabold text-[7.5px] border leading-none shrink-0 ${
                                            pr.rating >= 9 
                                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' 
                                              : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                          }`} title={pr.rating >= 9 ? "Production Ready" : "Requires Improvements"}>
                                            {pr.rating}/10
                                          </span>
                                        )}
                                        <span className={`px-1 py-0.2 rounded uppercase font-extrabold text-[7px] tracking-wide flex items-center gap-1 leading-none ${
                                          getStatusBadgeStyle(pr.status)
                                        }`}>
                                          {pr.status === 'In Progress' && (
                                            <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse shrink-0" />
                                          )}
                                          <span>{pr.status}</span>
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </button>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Section C: Live trigger settings & Router Switch */}
          <div className="p-4 border-white/5 bg-slate-950/45 border-t">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-extrabold font-mono mb-3">System LLM Router</h2>
            <div className="space-y-2 bg-slate-900/60 p-2.5 rounded-lg border border-white/5">
              <div>
                <label className="text-[9px] text-slate-500 uppercase font-mono font-bold block mb-1">Backend Target</label>
                <select 
                  value={backendOption}
                  onChange={(e) => setBackendOption(e.target.value as 'local' | 'cloud')}
                  className="w-full bg-slate-950 border border-white/10 rounded px-2 py-1 text-xs text-cyan-400 outline-hidden font-mono"
                >
                  <option value="cloud">Cloud (Gemini API)</option>
                  <option value="local">Local (Ollama Port)</option>
                </select>
              </div>

              {backendOption === 'local' ? (
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div>
                    <label className="text-[8px] text-slate-500 uppercase font-mono block mb-0.5">Ollama Port</label>
                    <input 
                      type="number"
                      value={localPort}
                      onChange={(e) => setLocalPort(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-white/10 rounded px-1.5 py-0.5 text-xs text-slate-300 font-mono text-center outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="text-[8px] text-slate-500 uppercase font-mono block mb-0.5">Model</label>
                    <select 
                      value={localModel}
                      onChange={(e) => setLocalModel(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-slate-350 font-mono outline-hidden"
                    >
                      <option value="codellama:13b">codellama</option>
                      <option value="deepseek-coder">deepseek-coder</option>
                      <option value="qwen2.5-coder">qwen2.5</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  <div className="text-[9px] text-slate-500 font-mono uppercase block mb-0.5 flex items-center justify-between">
                    <span>Model:</span>
                    <span className="text-cyan-400 font-bold">gemini-3.5-flash</span>
                  </div>
                  <div className="text-[9px] text-slate-600 font-mono leading-tight">
                    * Utilizing secure, server-side sandboxed pipeline. Exceeds standard token limits.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Section D: Recent Activity / Logs (at the bottom) */}
          <div className="p-4 border-t border-white/5 bg-[#0A0D13]">
            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 mb-3 font-extrabold font-mono">Recent Daemon Logs</div>
            <div className="space-y-2 max-h-24 overflow-y-auto pr-1">
              {logs.length === 0 ? (
                <div className="text-[10px] text-slate-600 font-mono">Waiting for git operations...</div>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="flex gap-2 text-[10px] font-mono leading-tight">
                    <div className="mt-1 w-1.5 h-1.5 rounded-full bg-cyan-400" />
                    <div className="flex-1 min-w-0">
                      <div className="text-slate-200 truncate">{log.action}</div>
                      <div className="text-[9px] text-slate-500">{log.target} • {log.time}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

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
                <motion.div 
                  key="pr-scanner-viewport"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="flex-1 flex flex-col xl:flex-row gap-5 overflow-hidden"
                >
                  
                  {/* Left panel: PR information and AI findings cards */}
                  <div className="flex-1 flex flex-col space-y-4 overflow-y-auto min-w-0 pr-1">
                    
                    {/* PR Title and Overview description */}
                    {activePR ? (
                      <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden group shrink-0">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />
                        
                        <div className="flex items-start justify-between gap-4 flex-wrap">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] font-mono uppercase bg-slate-800 text-slate-450 px-2 py-0.5 rounded font-bold border border-slate-750">
                                Active Pull Request View
                              </span>
                              <span className={`px-2 py-0.5 rounded uppercase font-extrabold text-[9px] font-mono flex items-center gap-1.5 shrink-0 select-none ${
                                getStatusBadgeStyle(activePR.status)
                              }`}>
                                {activePR.status === 'In Progress' && (
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                                )}
                                <span>{activePR.status}</span>
                              </span>
                              {activePR.rating !== undefined && activePR.rating !== null && (
                                <span className={`px-2 py-0.5 rounded uppercase font-mono text-[9px] font-bold border ${
                                  activePR.rating >= 9 
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' 
                                    : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                }`}>
                                  PROD GRADE: {activePR.rating}/10 ({activePR.rating >= 9 ? 'APPROVED' : 'REJECTED'})
                                </span>
                              )}
                            </div>
                            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight mt-1">{activePR.title}</h3>
                            <p className="text-xs text-slate-400 italic font-mono mt-1 text-slate-400">
                              {activePR.description || 'No description provided.'}
                            </p>
                          </div>

                          {/* Dynamic triggers scan */}
                          <div className="flex gap-2">
                            <button
                              disabled={isScanning}
                              onClick={handleTriggerPrScan}
                              className={`px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-black text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-md cursor-pointer select-none ${
                                isScanning ? 'animate-pulse opacity-50' : ''
                              }`}
                            >
                              <Zap size={14} className="fill-black" />
                              <span>{isScanning ? "AI Pipeline Working..." : "Trigger AI Review Scan"}</span>
                            </button>

                            {findings.length > 0 && (
                              <button
                                onClick={handleExportMarkdown}
                                className="px-3 py-2 bg-white/5 border border-white/10 text-slate-350 hover:bg-white/10 text-xs font-mono font-bold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                title="Download complete markdown report summary"
                              >
                                <Download size={13} />
                                <span>Export MD Card</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Scan warning or success notices */}
                        {scanResult && (
                          <div className="mt-3 p-2 bg-cyan-950/20 border border-cyan-800/30 rounded text-xs text-cyan-400 font-mono flex items-center justify-between">
                            <span>✓ Scan run completed: Discovered <strong className="text-emerald-400">{scanResult.count}</strong> alerts using <strong>{scanResult.model}</strong>.</span>
                            <button onClick={() => setScanResult(null)} className="hover:text-white p-0.5"><X size={12} /></button>
                          </div>
                        )}

                        {scanResult?.notice && (
                          <div className="mt-2 p-2 bg-amber-950/30 border border-amber-800/30 rounded text-xs text-amber-400 font-mono flex items-center gap-2">
                            <AlertTriangle size={14} className="shrink-0" />
                            <span>{scanResult.notice}</span>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3.5 pt-3.5 border-t border-white/5 text-[11px] font-mono text-slate-500">
                          <div className="flex items-center gap-1.5">
                            <User size={12} className="text-slate-600" />
                            <span>Author: <strong className="text-slate-300 font-semibold">{activePR.author}</strong></span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Hash size={12} className="text-slate-600" />
                            <span>Commit SHA: <strong className="text-slate-300 font-semibold">{activePR.commitHash}</strong></span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Calendar size={12} className="text-slate-600" />
                            <span>Detected: <strong className="text-slate-305 font-semibold">{new Date(activePR.createdAt).toLocaleDateString()}</strong></span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="h-64 flex flex-col items-center justify-center border border-white/10 border-dashed rounded-xl bg-slate-900/10 p-6 text-slate-500">
                        <GitBranch size={32} className="text-slate-700 animate-pulse mb-2" />
                        <p className="text-sm font-semibold font-mono">No Active Branch / PR selected</p>
                        <p className="text-xs text-slate-650 font-mono max-w-sm text-center mt-1">Select a workspace target from the sidebar menu to populate git branches and start AI security code audits.</p>
                      </div>
                    )}

                    {/* PR Stats Summaries */}
                    {activePR && (
                      <div className="p-3 bg-slate-905 border border-white/10 rounded-lg flex items-center justify-between gap-3 shrink-0">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-indigo-500/10 rounded text-indigo-400 border border-indigo-500/20">
                            <Activity size={15} />
                          </div>
                          <div>
                            <div className="text-[10px] text-slate-500 font-mono uppercase font-bold">PR Compliance Policy Status</div>
                            <div className="text-xs font-semibold text-white">Metrics checklist: Section 8 (Security, Correctness, Performance)</div>
                          </div>
                        </div>
                        <div className="flex gap-5 font-mono">
                          <div className="text-center">
                            <div className="text-xl font-bold text-rose-500">{findings.filter(f => f.severity === 'blocker' || f.severity === 'warning').length}</div>
                            <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Vulnerabilities / Warnings</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xl font-bold text-emerald-400">{findings.filter(f => f.severity === 'suggestion').length}</div>
                            <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Suggestions</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Review Findings List alerts cards */}
                    {activePR && (
                      <div className="space-y-3">
                        <h4 className="text-xs uppercase font-mono tracking-wider font-extrabold text-slate-500 flex items-center gap-1.5 pb-1">
                          <ShieldAlert size={13} className="text-rose-400 animate-pulse" />
                          <span>AI Core Code Audit Findings ({findings.length})</span>
                        </h4>

                        {findings.length === 0 ? (
                          <div className="p-8 text-center rounded-xl border border-white/5 bg-slate-950/20 text-slate-500 flex flex-col items-center justify-center">
                            <CheckCircle2 size={24} className="text-emerald-400 mb-1.5" />
                            <p className="text-xs font-bold text-slate-350 font-mono">Status: Ready for review scan</p>
                            <p className="text-[10px] text-slate-600 font-mono mt-0.5">Click "Trigger AI Review Scan" to run real-time static checking.</p>
                          </div>
                        ) : (
                          findings.map((finding) => (
                            <div 
                              key={finding.id}
                              className={`bg-[#0F1219] p-4 rounded-xl border transition-all flex flex-col gap-3 relative overflow-hidden group ${
                                finding.severity === 'blocker' 
                                  ? 'border-rose-500/25 bg-rose-500/[0.01] hover:border-rose-500/40' 
                                  : finding.severity === 'warning' 
                                  ? 'border-amber-500/25 bg-amber-500/[0.01] hover:border-amber-500/40' 
                                  : 'border-white/10 hover:border-cyan-500/30'
                              }`}
                            >
                              <div className="flex items-center justify-between flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase font-mono border ${
                                    finding.severity === 'blocker' 
                                      ? 'bg-rose-500/15 text-rose-400 border-rose-500/25' 
                                      : finding.severity === 'warning'
                                      ? 'bg-amber-500/15 text-amber-400 border-amber-500/25'
                                      : 'bg-slate-800 text-slate-400 border-slate-750'
                                  }`}>
                                    {finding.severity}
                                  </span>
                                  <span className="text-[10px] font-mono text-cyan-400 bg-cyan-400/5 px-1.5 rounded font-bold uppercase tracking-wider">{finding.category}</span>
                                  <span className="text-xs font-semibold text-white tracking-tight">{finding.filename}</span>
                                </div>
                                <span className="text-[10px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
                                  Line {finding.line}
                                </span>
                              </div>

                              <p className="text-xs text-slate-350 leading-relaxed font-sans mt-0.5">
                                {finding.explanation}
                              </p>

                              {finding.evidenceChain && (typeof finding.evidenceChain === 'string' ? JSON.parse(finding.evidenceChain) : finding.evidenceChain).length > 0 && (
                                <div className="mt-1.5 text-xs font-mono bg-slate-950/50 p-3 rounded-lg border border-white/5 space-y-2">
                                  <div className="text-[10px] text-cyan-400 uppercase font-bold flex items-center gap-1.5 border-b border-white/5 pb-1 select-none">
                                    <Network size={12} className="text-cyan-400" />
                                    <span>Core Call-Graph Investigation Log</span>
                                  </div>
                                  <div className="space-y-2 pl-1 border-l border-cyan-500/20 ml-1.5">
                                    {(typeof finding.evidenceChain === 'string' ? JSON.parse(finding.evidenceChain) : finding.evidenceChain).map((point: any, pIdx: number) => (
                                      <div key={pIdx} className="text-[11px] leading-relaxed flex items-start gap-1.5">
                                        <span className="text-cyan-500 font-extrabold select-none shrink-0">[{pIdx + 1}]</span>
                                        <span className="text-slate-400">
                                          <strong className="text-slate-300">{point.file}</strong> (Line {point.line}): {point.text}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {finding.diffSuggestion && (
                                <div className="relative">
                                  <div className="bg-black/50 rounded-lg p-3 font-mono text-xs text-slate-300 border border-white/5 overflow-x-auto select-all max-h-48 whitespace-pre">
                                    <div className="text-slate-600 text-[10px] font-semibold border-b border-white/5 pb-1 mb-2 select-none uppercase tracking-wide flex items-center justify-between">
                                      <span>Suggested Fix</span>
                                      <button 
                                        onClick={() => handleCopyCode(finding.diffSuggestion, finding.id)}
                                        className="hover:text-white transition-colors"
                                      >
                                        {copyFeedback === finding.id ? "Copied!" : "Copy Fix"}
                                      </button>
                                    </div>
                                    <div className="text-[11px] font-mono leading-relaxed text-slate-300">
                                      {finding.diffSuggestion}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right panel: Files involved lists & Code diff visual frame */}
                  <div className="w-full xl:w-96 shrink-0 flex flex-col gap-4 overflow-hidden min-h-0 bg-slate-950/20 border border-white/10 rounded-xl p-4">
                    
                    <div>
                      <h4 className="text-[10px] font-mono font-extrabold text-slate-500 uppercase tracking-[0.2em] mb-2.5">
                        Files Involved in PR
                      </h4>
                      
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                        {prFiles.map((file) => {
                          const isSelected = selectedFilename === file.filename;
                          return (
                            <button
                              key={file.filename}
                              onClick={() => setSelectedFilename(file.filename)}
                              className={`w-full text-left p-2.5 rounded-lg border transition-all text-xs font-mono flex items-center justify-between ${
                                isSelected 
                                  ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-400' 
                                  : 'border-transparent hover:bg-white/5 text-slate-400 hover:text-white'
                              }`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <FileCode2 size={13} className={isSelected ? "text-cyan-400" : "text-slate-500"} />
                                <span className="truncate">{file.filename}</span>
                              </div>
                              <div className="flex items-center gap-1 text-[9px] font-bold shrink-0">
                                <span className="text-emerald-500">+{file.additions}</span>
                                <span className="text-rose-500">-{file.deletions}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Diff/Code box code highlight */}
                    <div className="flex-1 flex flex-col min-h-0 bg-slate-950 rounded-xl border border-white/10 overflow-hidden shadow-2xl relative">
                      
                      {/* Diff Top bar */}
                      <div className="bg-[#090C12] py-2 px-3 border-b border-white/10 flex items-center justify-between font-mono text-[10px] text-slate-400 select-none">
                        <div className="flex items-center gap-2">
                          <div className="flex gap-1">
                            <div className="w-2 h-2 rounded-full bg-rose-500/80"></div>
                            <div className="w-2 h-2 rounded-full bg-amber-500/80"></div>
                            <div className="w-2 h-2 rounded-full bg-emerald-500/80"></div>
                          </div>
                          <span className="text-[11px] text-cyan-400 font-bold truncate max-w-[180px]">{activeFile?.filename || 'Git Diff View'}</span>
                        </div>
                        <div className="text-[8px] uppercase tracking-wider font-extrabold bg-white/5 px-2 py-0.5 rounded text-slate-400 border border-white/5 shrink-0">
                          RAW GIT HEADER
                        </div>
                      </div>

                      {/* Display Code view body */}
                      <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-slate-300 max-h-[380px] lg:max-h-[500px] select-text">
                        {activeFile ? (
                          <div className="space-y-1">
                            {/* Fast display of line codes with green addition & red status */}
                            {(activeFile.diff || activeFile.modifiedContent || '').split('\n').map((line, idx) => {
                              const isAddition = line.startsWith('+') && !line.startsWith('+++');
                              const isDeletion = line.startsWith('-') && !line.startsWith('---');
                              const isHeader = line.startsWith('@@') || line.startsWith('diff') || line.startsWith('index');

                              return (
                                <div 
                                  key={idx} 
                                  className={`py-0.5 px-1.5 rounded-sm transition-colors ${
                                    isAddition 
                                      ? 'bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500 font-bold' 
                                      : isDeletion 
                                      ? 'bg-rose-500/10 text-rose-350 border-l-2 border-rose-500 line-through'
                                      : isHeader
                                      ? 'text-cyan-500 font-bold tracking-tight border-b border-cyan-500/5 my-1 bg-cyan-950/10'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  <pre className="whitespace-pre-wrap word-break break-all font-mono">{line}</pre>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="h-48 flex items-center justify-center text-slate-600 italic">
                            Select an involved file to inspect git patch changes.
                          </div>
                        )}
                      </div>

                    </div>

                  </div>

                </motion.div>
              )}
            </AnimatePresence>

          </div>

          {/* High-Tech Terminal Footer / Statistics Row */}
          <footer className="p-4 border-t border-white/5 bg-[#0F1219] flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex gap-4 text-[10px] text-slate-500 uppercase font-mono">
              <span>ACTIVE PIPELINE: <strong className="text-[#10b981] animate-pulse">daemon.listener</strong></span>
              <span>COMPLIANCE POLICY: <strong className="text-indigo-400">Sleek Woodhill compliance v1.6.2</strong></span>
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
          <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0F1219] border border-white/15 w-full max-w-md rounded-xl overflow-hidden shadow-2xl"
            >
              <div className="px-5 py-4 bg-slate-950/70 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-cyan-400 animate-pulse" />
                  <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">Link Local Repo Directory</span>
                </div>
                <button 
                  onClick={() => {
                    setShowAddRepoModal(false);
                    setErrorFeedback(null);
                  }}
                  className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={handleAddRepo} className="p-5 flex flex-col gap-4 text-xs font-mono">
                {errorFeedback && (
                  <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
                    <AlertCircle size={14} className="shrink-0" />
                    <span>{errorFeedback}</span>
                  </div>
                )}

                <div>
                  <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Project Name / Alias</label>
                  <input 
                    required
                    type="text"
                    placeholder="e.g. fast-api-layer"
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700"
                  />
                </div>

                <div>
                  <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Absolute Folder Disk Path</label>
                  <input 
                    required
                    type="text"
                    placeholder="e.g. ./ or /Users/work/server"
                    value={newRepoPath}
                    onChange={(e) => setNewRepoPath(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700"
                  />
                  <div className="text-[9px] text-slate-600 mt-1">
                    * Pro tip: Input <strong className="text-slate-400">./</strong> to read branches and runs live reviews on this Woodhill repo!
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Base Branch</label>
                    <input 
                      type="text"
                      placeholder="main"
                      value={newBaseBranch}
                      onChange={(e) => setNewBaseBranch(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Branch Matcher</label>
                    <input 
                      type="text"
                      placeholder="feature/*"
                      value={newBranchPattern}
                      onChange={(e) => setNewBranchPattern(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-300 outline-hidden focus:border-cyan-500 transition-all"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Listener Trigger</label>
                    <select 
                      value={newTriggerMode}
                      onChange={(e) => setNewTriggerMode(e.target.value as 'auto' | 'mention')}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-350 outline-hidden focus:border-cyan-500 transition-all cursor-pointer"
                    >
                      <option value="auto">auto pipeline</option>
                      <option value="mention">@PRBot mention</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">Quiet Cooldown (sec)</label>
                    <input 
                      type="number"
                      min={1}
                      max={600}
                      value={newQuietPeriod}
                      onChange={(e) => setNewQuietPeriod(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all"
                    />
                  </div>
                </div>

                <div className="flex gap-2.5 mt-2.5 pt-4 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddRepoModal(false);
                      setErrorFeedback(null);
                    }}
                    className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2.5 rounded font-bold transition-all cursor-pointer text-center"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 bg-cyan-500 hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(6,182,212,0.3)] text-black py-2.5 rounded font-bold transition-all cursor-pointer text-center block"
                  >
                    Register Link
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
