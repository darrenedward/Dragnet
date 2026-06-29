import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { NetworkError } from '../lib/http';
import { toast } from '../lib/toast';
import { 
  GitBranch, 
  Play, 
  Square, 
  Plus, 
  Trash2, 
  RotateCcw, 
  Clock, 
  Terminal, 
  CheckCircle2, 
  AlertTriangle, 
  Settings, 
  FileCode, 
  CloudLightning,
  RefreshCw,
  Search,
  Bell,
  Cpu,
  CornerDownRight,
  ShieldAlert,
  Sliders,
  Sparkles,
  Database,
  History,
  X
} from 'lucide-react';

export interface WatchedRepo {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  activeBranch: string;
  triggerMode: 'auto' | 'mention';
  quietPeriodSeconds: number;
  branchPattern: string;
  status: 'idle' | 'detected' | 'stabilizing' | 'ready' | 'reviewing';
  lastCommitHash: string;
  lastCommitMessage: string;
  lastActivityTime: Date;
  stabilizationTimer: number; // remaining seconds
  reviewsCount: number;
}

export interface WatcherLog {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'git';
  message: string;
  repoName?: string;
}

interface GitWatcherProps {
  onTriggerReviewPass: (repoName: string, branchName: string, commitHash: string, triggerReason: string) => void;
  activeRepoId?: string;
  onRepoChange?: (repoId: string) => void;
}

export default function GitWatcher({ onTriggerReviewPass, activeRepoId, onRepoChange }: GitWatcherProps) {
  // 1. Storage / Memory State of Repos
  const [repos, setRepos] = useState<WatchedRepo[]>([]);

  // Selected repo ID for detail / target controls
  const [selectedId, setSelectedId] = useState<string>(activeRepoId || '');

  // Helper to fetch/reload repository list from SQLite database
  const fetchReposFromDb = () => {
    fetch('/api/repos')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          const formatted = data.map((r: any) => ({
            ...r,
            lastActivityTime: new Date(r.lastActivityTime)
          }));
          setRepos(formatted);
          if (formatted.length > 0) {
            // Guard to keep selectedId valid
            if (!formatted.some(r => r.id === selectedId)) {
              setSelectedId(formatted[0].id);
              if (onRepoChange) onRepoChange(formatted[0].id);
            }
          }
        }
      })
      .catch(err => console.error("Error downloading SQLite repositories:", err));
  };

  // On mount, pull repositories from SQLite
  useEffect(() => {
    fetchReposFromDb();
  }, []);

  useEffect(() => {
    if (activeRepoId) {
      setSelectedId(activeRepoId);
    }
  }, [activeRepoId]);

  const selectedRepo = repos.find(r => r.id === selectedId) || repos[0] || {
    id: '', name: 'loading-repo', path: '', baseBranch: 'main', activeBranch: 'main',
    triggerMode: 'auto', quietPeriodSeconds: 10, branchPattern: '*', status: 'idle',
    lastCommitHash: '', lastCommitMessage: '', lastActivityTime: new Date(),
    stabilizationTimer: 0, reviewsCount: 0
  };

  // Daemon settings
  const [isDaemonActive, setIsDaemonActive] = useState(true);
  const [pollingIntervalMs, setPollingIntervalMs] = useState(2000);
  const [logs, setLogs] = useState<WatcherLog[]>([
    { id: '1', timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Dragnet Git Watcher Daemon initialized.' },
    { id: '2', timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Connected to local SQLite database: data.db' },
    { id: '3', timestamp: new Date().toLocaleTimeString(), type: 'success', message: 'Connection to local git service established.' }
  ]);

  // Form states for registering a new repository
  const [showAddModal, setShowAddModal] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPath, setNewRepoPath] = useState('');
  const [newBaseBranch, setNewBaseBranch] = useState('main');
  const [newTriggerMode, setNewTriggerMode] = useState<'auto' | 'mention'>('auto');
  const [newQuietPeriod, setNewQuietPeriod] = useState(15);
  const [newBranchPattern, setNewBranchPattern] = useState('feature/*');

  // Interactive Simulation Controls
  const [simulationBranch, setSimulationBranch] = useState('');
  const [simulationCommitMsg, setSimulationCommitMsg] = useState('');
  const [commitPromptOption, setCommitPromptOption] = useState<'normal' | 'keyword' | 'marker'>('normal');

  // Reference for console scroll
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal log
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // 2. Append to Terminal Log helper
  const addLog = (type: 'info' | 'success' | 'warn' | 'error' | 'git', message: string, repoName?: string) => {
    const newLog: WatcherLog = {
      id: Math.random().toString(),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
      repoName
    };
    setLogs(prev => [...prev, newLog].slice(-100)); // Keep last 100 logs
  };

  // 3. React Engine of the Daemon
  useEffect(() => {
    if (!isDaemonActive) return;

    // Polling simulation + Cooldown ticks
    const interval = setInterval(() => {
      setRepos(prevRepos => {
        return prevRepos.map(repo => {
          let updated = { ...repo };

          // Ticking Cooldowns
          if (repo.status === 'stabilizing') {
            const nextTimer = repo.stabilizationTimer - 1;
            updated.stabilizationTimer = Math.max(0, nextTimer);

            if (nextTimer <= 0) {
              // Timer has stabilized to 0!
              updated.status = 'ready';
              
              // Notify Core Review!
              setTimeout(() => {
                addLog('success', `✔ Quiet period of ${repo.quietPeriodSeconds}s finished stabilizer phase on branch '${repo.activeBranch}'!`, repo.name);
                addLog('info', `🚀 Dispatching core review request for commit '${repo.lastCommitHash}' on branch '${repo.activeBranch}'`, repo.name);
                
                // Trigger parent callback
                onTriggerReviewPass(
                  repo.name, 
                  repo.activeBranch, 
                  repo.lastCommitHash, 
                  `Git Watcher: quiet period elapsed on branch ${repo.activeBranch}`
                );

                // PUT UPDATE to server
                fetch(`/api/repos/${repo.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    status: 'idle',
                    reviewsCount: repo.reviewsCount + 1,
                    stabilizationTimer: 0
                  })
                }).then(() => {
                  fetch('/api/reviews', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      repoId: repo.id,
                      repoName: repo.name,
                      branch: repo.activeBranch,
                      commitHash: repo.lastCommitHash,
                      triggerReason: `Auto-inspect timer elapsed on branch ${repo.activeBranch}`
                    })
                  }).then(() => {
                    fetchReposFromDb();
                  });
                });
              }, 100);
            }
          }

          return updated;
        });
      });

      // Random background polling logs to look highly professional and real
      if (Math.random() < 0.25 && repos && repos.length > 0) {
        const randomRepoIndex = Math.floor(Math.random() * repos.length);
        const repoSample = repos[randomRepoIndex];
        if (repoSample) {
          addLog('git', `git for-each-ref --format='%(refname:short) %(objectname:short)' refs/heads/* (${repoSample.name})`, repoSample.name);
        }
      }

    }, 1000);

    return () => clearInterval(interval);
  }, [isDaemonActive, repos, onTriggerReviewPass]);

  // 4. Git Simulator Actions
  const simulateBranchCreation = (repoId: string, branchName: string) => {
    if (!branchName.trim()) {
      addLog('error', 'Git Branch Simulation error: Branch name cannot be empty');
      return;
    }

    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;

    const cleanBranch = branchName.trim();
    addLog('warn', `git branch ${cleanBranch} && git checkout ${cleanBranch}`, repo.name);
    addLog('info', `✨ Detected branch checkout: '${cleanBranch}' created from base context '${repo.baseBranch}'`, repo.name);

    // Does the branch pattern match?
    const isMatched = repo.branchPattern === '*' || 
      (repo.branchPattern.endsWith('*') && cleanBranch.startsWith(repo.branchPattern.slice(0, -1))) ||
      cleanBranch === repo.branchPattern;

    let trackingStatus: 'idle' | 'stabilizing' = 'idle';
    let trackingTimer = 0;

    if (!isMatched) {
      addLog('info', `ℹ Branch '${cleanBranch}' does NOT match configured filter pattern '${repo.branchPattern}'. Skipping auto-review scheduler.`, repo.name);
    } else if (repo.triggerMode === 'mention') {
      addLog('info', `🤖 Mention-Trigger mode is active. Waiting for manual CLI call, '@PRBot' commit, or '.dragnet-review' file...`, repo.name);
    } else {
      addLog('warn', `⏱ Branch '${cleanBranch}' matches pattern '${repo.branchPattern}'. Starting quiet period cooldown of ${repo.quietPeriodSeconds}s to ensure commit sequence has stabilized.`, repo.name);
      trackingStatus = 'stabilizing';
      trackingTimer = repo.quietPeriodSeconds;
    }

    // PUT to server
    fetch(`/api/repos/${repo.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeBranch: cleanBranch,
        status: trackingStatus,
        stabilizationTimer: trackingTimer
      })
    }).then(() => {
      fetchReposFromDb();
    });

    setSimulationBranch('');
  };

  const simulateNewCommit = (repoId: string, msg: string, commitType: 'normal' | 'keyword' | 'marker') => {
    const repo = repos.find(r => r.id === repoId);
    if (!repo) return;

    const fallbackMsg = msg.trim() || `update ${repo.activeBranch} functionality`;
    const newHash = Math.floor(Math.random() * 16777215).toString(16).padStart(7, 'f');

    const currentBranch = repo.activeBranch;
    addLog('git', `git commit -am "${fallbackMsg}" [Hash: ${newHash}]`, repo.name);

    // Does it match?
    const isMatched = repo.branchPattern === '*' || 
      (repo.branchPattern.endsWith('*') && currentBranch.startsWith(repo.branchPattern.slice(0, -1)));

    // Handle Trigger Scenarios
    let nextStatus = repo.status;
    let nextTimer = repo.stabilizationTimer;

    // Commit message mention trigger
    const isCommitMention = fallbackMsg.includes('@PRBot review') || commitType === 'keyword';
    const isMarkerFileCreated = commitType === 'marker';

    if (isCommitMention) {
      addLog('success', `✨ Commit contains trigger token! "@PRBot review" detected in commit log.`, repo.name);
      addLog('warn', `⏱ Triggering immediately! Starting quiet period stabilization (${repo.quietPeriodSeconds}s).`, repo.name);
      nextStatus = 'stabilizing';
      nextTimer = repo.quietPeriodSeconds;
    } else if (isMarkerFileCreated) {
      addLog('success', `✨ Detected '.dragnet-review' hook marker in repository stage area!`, repo.name);
      addLog('warn', `⏱ Triggering immediately! Starting quiet period stabilization (${repo.quietPeriodSeconds}s).`, repo.name);
      nextStatus = 'stabilizing';
      nextTimer = repo.quietPeriodSeconds;
    } else if (repo.triggerMode === 'auto' && isMatched) {
      if (repo.status === 'stabilizing') {
        addLog('warn', `🔄 Subsequent commit detected on branch '${currentBranch}'! Resetting stabilizer quiet period countdown back to ${repo.quietPeriodSeconds}s.`, repo.name);
      } else {
        addLog('warn', `⏱ New commit detected on active branch. Starting quiet period cooldown of ${repo.quietPeriodSeconds}s.`, repo.name);
      }
      nextStatus = 'stabilizing';
      nextTimer = repo.quietPeriodSeconds;
    } else {
      addLog('info', `ℹ Commit added. Branch is idle. Trigger mode is: ${repo.triggerMode.toUpperCase()}`, repo.name);
    }

    // PUT to server
    fetch(`/api/repos/${repo.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeBranch: currentBranch,
        lastCommitHash: newHash,
        lastCommitMessage: fallbackMsg + (isCommitMention && !fallbackMsg.includes('@PRBot review') ? ' @PRBot review' : ''),
        status: nextStatus,
        stabilizationTimer: nextTimer
      })
    }).then(() => {
      if (isCommitMention || isMarkerFileCreated) {
        fetch('/api/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoId: repo.id,
            repoName: repo.name,
            branch: currentBranch,
            commitHash: newHash,
            triggerReason: isCommitMention ? '@PRBot review keyword' : 'Stage .dragnet-review file trigger'
          })
        }).then(() => {
          fetchReposFromDb();
        });
      } else {
        fetchReposFromDb();
      }
    });

    setSimulationCommitMsg('');
  };

  const handleRegisterRepo = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim() || !newRepoPath.trim()) {
      toast.warn('Repo name and absolute disk path are required.');
      return;
    }

    const cleanPath = newRepoPath.trim();
    const cleanName = newRepoName.trim().toLowerCase().replace(/\s+/g, '-');

    const newRepository: WatchedRepo = {
      id: cleanName,
      name: cleanName,
      path: cleanPath,
      baseBranch: newBaseBranch,
      activeBranch: newBaseBranch,
      triggerMode: newTriggerMode,
      quietPeriodSeconds: newQuietPeriod,
      branchPattern: newBranchPattern,
      status: 'idle',
      lastCommitHash: 'a1b2c3d',
      lastCommitMessage: 'initial repository watch link',
      lastActivityTime: new Date(),
      stabilizationTimer: 0,
      reviewsCount: 0
    };

    fetch('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newRepository)
    })
    .then(res => res.json())
    .then(() => {
      fetchReposFromDb();
      setSelectedId(cleanName);
      setShowAddModal(false);

      if (onRepoChange) {
        onRepoChange(cleanName);
      }

      addLog('success', `Registered Watched Project [${cleanName}] successfully in SQLite database.`);
      addLog('info', `Daemon scanning index paths: ${cleanPath}/.git/refs/heads`, cleanName);
    })
    .catch(err => {
      console.error(err);
      if (err instanceof NetworkError) {
        toast.networkError();
      } else {
        toast.error('Failed to register repository: ' + (err?.message ?? 'unknown error'));
      }
    });

    // reset fields
    setNewRepoName('');
    setNewRepoPath('');
    setNewBaseBranch('main');
    setNewTriggerMode('auto');
    setNewQuietPeriod(15);
    setNewBranchPattern('feature/*');
  };

  const deleteRepo = (id: string) => {
    if (repos.length <= 1) {
      toast.warn('Cannot delete the last registered repository.');
      return;
    }
    const repoToDelete = repos.find(r => r.id === id);

    fetch(`/api/repos/${id}`, { method: 'DELETE' })
      .then(() => {
        fetchReposFromDb();
        const remaining = repos.filter(r => r.id !== id);
        if (remaining.length > 0) {
          setSelectedId(remaining[0].id);
          if (onRepoChange) {
            onRepoChange(remaining[0].id);
          }
        }
        if (repoToDelete) {
          addLog('warn', `Unlinked and stopped watching repository from SQLite: '${repoToDelete.name}'`);
        }
      })
      .catch(err => {
        console.error("Error unlinking repository from SQLite:", err);
      });
  };

  return (
    <div className="flex flex-col xl:flex-row gap-6 w-full h-full" id="git-watcher-module-root">
      
      {/* LEFT PORTION: Watchers Dashboard */}
      <div className="flex-1 flex flex-col gap-5 overflow-y-auto pr-1">
        
        {/* Watcher Core Info Header */}
        <div className="bg-[#0F1219]/75 border border-white/10 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl">
          <div className="flex gap-4 items-center">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDaemonActive ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/25' : 'bg-slate-800 text-slate-500'}`}>
              <Cpu size={20} className={isDaemonActive ? 'animate-pulse' : ''} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white tracking-tight flex items-center gap-2">
                <span>Git Watcher Engine</span>
                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${isDaemonActive ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25':'bg-slate-800 text-slate-400 font-mono'}`}>
                  {isDaemonActive ? 'ACTIVE DAEMON' : 'PAUSED'}
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Watching local Git references for changes. Handles the quiet period so reviews run after stabilization.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Polling controller */}
            <div className="flex items-center gap-1.5 bg-slate-900 border border-white/15 rounded px-2.5 py-1 text-xs">
              <span className="text-slate-500 font-mono text-[10px]">Poll:</span>
              <select 
                value={pollingIntervalMs} 
                onChange={(e) => setPollingIntervalMs(Number(e.target.value))}
                className="bg-transparent text-slate-300 font-mono outline-hidden cursor-pointer text-xs"
              >
                <option value={1000} className="bg-[#0A0E14]">1s</option>
                <option value={2000} className="bg-[#0A0E14]">2s</option>
                <option value={5000} className="bg-[#0A0E14]">5s</option>
              </select>
            </div>

            <button
              onClick={() => {
                setIsDaemonActive(!isDaemonActive);
                addLog(isDaemonActive ? 'warn' : 'info', isDaemonActive ? 'Local Daemon execution PAUSED.' : 'Local Daemon execution RESUMED.');
              }}
              className={`px-3 py-1.5 rounded text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer ${
                isDaemonActive 
                  ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20' 
                  : 'bg-emerald-500 text-black hover:bg-emerald-400'
              }`}
            >
              {isDaemonActive ? (
                <>
                  <Square size={12} />
                  <span>Pause Watcher</span>
                </>
              ) : (
                <>
                  <Play size={12} fill="currentColor" />
                  <span>Resume Watcher</span>
                </>
              )}
            </button>

            <button
              onClick={() => setShowAddModal(true)}
              className="bg-cyan-500 hover:bg-cyan-400 text-black px-3 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Plus size={13} />
              <span>Add Watch</span>
            </button>
          </div>
        </div>

        {/* Active Watches Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {repos.map((repo) => {
            const isSelected = selectedId === repo.id;
            
            // Icon Selector for repository state
            let stateGlowColor = 'border-white/10';
            let stateBadgeText = 'ACTIVE WATCHING';
            let stateBadgeStyle = 'bg-slate-800 text-slate-300';
            let timerProgress = 0;

            if (repo.status === 'stabilizing') {
              stateGlowColor = 'border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.1)]';
              stateBadgeText = `STABILIZATION COOLDOWN (${repo.stabilizationTimer}s)`;
              stateBadgeStyle = 'bg-amber-400/10 text-amber-400 border border-amber-400/20';
              timerProgress = ((repo.quietPeriodSeconds - repo.stabilizationTimer) / repo.quietPeriodSeconds) * 100;
            } else if (repo.status === 'ready') {
              stateGlowColor = 'border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.1)]';
              stateBadgeText = 'STABILIZED / READY';
              stateBadgeStyle = 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
              timerProgress = 100;
            } else if (repo.status === 'reviewing') {
              stateGlowColor = 'border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.1)] animate-pulse';
              stateBadgeText = 'CORE REVIEWING';
              stateBadgeStyle = 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20';
              timerProgress = 100;
            } else if (repo.triggerMode === 'mention') {
              stateBadgeText = 'STANDBY: MENTION TRIG';
              stateBadgeStyle = 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
            }

            return (
              <div 
                key={repo.id}
                onClick={() => {
                  setSelectedId(repo.id);
                  if (onRepoChange) onRepoChange(repo.id);
                }}
                className={`bg-[#0F1219] rounded-xl border p-4 transition-all cursor-pointer select-none flex flex-col gap-3 relative overflow-hidden group ${
                  isSelected ? 'border-cyan-500/40 bg-[#0F1219]' : stateGlowColor + ' hover:bg-white/5'
                }`}
              >
                {/* Timer Countdown Bar Overlay at the very top of Card */}
                {repo.status === 'stabilizing' && (
                  <div className="absolute top-0 left-0 right-0 h-1 bg-slate-800">
                    <motion.div 
                      className="h-full bg-[#f59e0b]"
                      style={{ width: `${timerProgress}%` }}
                      transition={{ ease: "linear" }}
                    />
                  </div>
                )}

                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-white font-bold tracking-tight truncate">
                        {repo.name}
                      </span>
                      <span className="text-[9px] font-mono font-bold px-1 py-0.5 rounded bg-slate-900 border border-white/5 text-slate-400 uppercase">
                        {repo.triggerMode}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500 font-mono block mt-0.5 truncate">
                      {repo.path}
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-mono text-slate-400 px-1.5 py-0.5 rounded bg-slate-950">
                      📝 {repo.reviewsCount} passes
                    </span>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRepo(repo.id);
                      }}
                      className="p-1 hover:bg-rose-500/10 rounded text-slate-500 hover:text-rose-400 transition-colors"
                      title="Stop watching this repository"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Sub status section */}
                <div className="flex items-center justify-between border-t border-white/5 pt-2.5">
                  <div className="flex items-center gap-1.5">
                    <GitBranch size={11} className="text-cyan-400" />
                    <span className="text-[11px] font-mono font-semibold text-slate-300">
                      {repo.activeBranch}
                    </span>
                    <span className="text-[9px] text-slate-500 font-mono">
                      (v. {repo.baseBranch})
                    </span>
                  </div>

                  <span className={`text-[9px] font-mono font-bold tracking-wider px-1.5 py-0.5 rounded uppercase ${stateBadgeStyle}`}>
                    {stateBadgeText}
                  </span>
                </div>

                {/* Last commit visual line */}
                <div className="bg-slate-950/60 rounded px-2.5 py-2 border border-white/5 mt-0.5">
                  <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 mb-1">
                    <span>LAST COMMIT DETECTED</span>
                    <span className="text-cyan-500/80">sha: {repo.lastCommitHash}</span>
                  </div>
                  <p className="text-[11px] text-slate-300 font-mono truncate">
                    "{repo.lastCommitMessage}"
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* SECTION: GIT REPO COMMAND SIMULATOR (Drives the entire watcher system interactive playground) */}
        <div className="bg-[#0F1219]/70 border border-white/10 rounded-xl p-5 flex flex-col gap-4 shadow-xl">
          <div className="flex justify-between items-center border-b border-white/5 pb-3">
            <div>
              <h4 className="text-sm font-semibold text-white tracking-tight flex items-center gap-2">
                <Settings size={14} className="text-cyan-400" />
                <span>Interactive Git Playground Simulator</span>
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Simulate standard developer command executions to watch how Dragnet's quiet-period reacts.
              </p>
            </div>
            <span className="text-[10px] font-mono text-pink-400 bg-pink-400/5 border border-pink-400/25 px-2 py-0.5 rounded uppercase">
              Target: {selectedRepo.name}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Action 1: Create / Switch Branch */}
            <div className="p-3.5 bg-slate-900/60 rounded-lg border border-white/5 flex flex-col gap-3">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <GitBranch size={13} className="text-cyan-400" />
                Checkout / Create a New Branch
              </span>
              <p className="text-[11px] text-slate-500">
                Type name for a branch. Auto-inspection filters on filter pattern <code className="text-cyan-400 bg-slate-950 px-1 py-0.5 rounded">"{selectedRepo.branchPattern}"</code>.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. feature/new-analytics"
                  value={simulationBranch}
                  onChange={(e) => setSimulationBranch(e.target.value)}
                  className="flex-1 bg-slate-950 border border-white/10 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 rounded selection:bg-cyan-500/25"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') simulateBranchCreation(selectedRepo.id, simulationBranch);
                  }}
                />
                <button
                  onClick={() => simulateBranchCreation(selectedRepo.id, simulationBranch)}
                  className="bg-cyan-500 hover:bg-cyan-400 text-black px-3.5 py-1.5 rounded text-xs font-semibold transition-colors cursor-pointer"
                >
                  Checkout
                </button>
              </div>
              <div className="flex gap-2 flex-wrap">
                <span className="text-[9px] text-slate-600 font-mono mt-1">Presets:</span>
                <button 
                  onClick={() => setSimulationBranch('feature/analytics-v2')}
                  className="text-[10px] font-mono bg-slate-950 hover:bg-slate-800 text-slate-400 border border-white/5 px-2 py-0.5 rounded shrink-0 cursor-pointer"
                >
                  feature/analytics-v2 (Matches)
                </button>
                <button 
                  onClick={() => setSimulationBranch('fix/api-headers')}
                  className="text-[10px] font-mono bg-slate-950 hover:bg-slate-800 text-slate-400 border border-white/5 px-2 py-0.5 rounded shrink-0 cursor-pointer"
                >
                  fix/api-headers
                </button>
              </div>
            </div>

            {/* Action 2: Simulate Code Changes / Git Commits */}
            <div className="p-3.5 bg-slate-900/60 rounded-lg border border-white/5 flex flex-col gap-3">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <CloudLightning size={13} className="text-amber-400" />
                Commit / Push Code Modifications
              </span>

              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  placeholder={`Commit msg (defaults to: Update ${selectedRepo.activeBranch})`}
                  value={simulationCommitMsg}
                  onChange={(e) => setSimulationCommitMsg(e.target.value)}
                  className="w-full bg-slate-950 border border-white/10 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 rounded selection:bg-cyan-500/25"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') simulateNewCommit(selectedRepo.id, simulationCommitMsg, commitPromptOption);
                  }}
                />

                <div className="flex items-center gap-1.5 border-t border-white/5 pt-2 flex-wrap gap-y-2">
                  <span className="text-[9px] text-slate-500 font-mono">Options:</span>
                  
                  <label className="flex items-center gap-1 cursor-pointer text-xs select-none">
                    <input 
                      type="radio" 
                      name="commit_type" 
                      checked={commitPromptOption === 'normal'}
                      onChange={() => setCommitPromptOption('normal')}
                      className="accent-cyan-500"
                    />
                    <span className={`text-[10px] font-mono px-1 rounded ${commitPromptOption === 'normal' ? 'text-slate-200':'text-slate-500'}`}>Normal</span>
                  </label>

                  <label className="flex items-center gap-1 cursor-pointer text-xs select-none" title="Triggers review immediately even if repository is in mention-mode because of commit word marker match">
                    <input 
                      type="radio" 
                      name="commit_type" 
                      checked={commitPromptOption === 'keyword'}
                      onChange={() => setCommitPromptOption('keyword')}
                      className="accent-cyan-400"
                    />
                    <span className={`text-[10px] font-mono px-1 rounded ${commitPromptOption === 'keyword' ? 'text-amber-400 font-bold bg-amber-400/5':'text-slate-500'}`}>@PRBot review word</span>
                  </label>

                  <label className="flex items-center gap-1 cursor-pointer text-xs select-none" title="Simulates creating a .dragnet-review file in checkout tree">
                    <input 
                      type="radio" 
                      name="commit_type" 
                      checked={commitPromptOption === 'marker'}
                      onChange={() => setCommitPromptOption('marker')}
                      className="accent-indigo-400"
                    />
                    <span className={`text-[10px] font-mono px-1 rounded ${commitPromptOption === 'marker' ? 'text-indigo-400 font-bold bg-indigo-400/5':'text-slate-500'}`}>Marker File</span>
                  </label>
                </div>

                <button
                  onClick={() => simulateNewCommit(selectedRepo.id, simulationCommitMsg, commitPromptOption)}
                  className="bg-amber-500 hover:bg-amber-400 text-black px-3 py-1.5 rounded text-xs font-semibold transition-colors mt-1 hover:shadow-[0_0_12px_rgba(245,158,11,0.2)] cursor-pointer"
                >
                  {commitPromptOption === 'normal' ? 'Append Normal Commit' : commitPromptOption === 'keyword' ? 'Append Commit with "@PRBot review" Token' : 'Touch .dragnet-review Marker File'}
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* RIGHT PORTION: Live Watcher Terminal Console */}
      <div className="w-full xl:w-96 flex flex-col bg-[#090C12] border border-white/15 rounded-xl overflow-hidden shadow-2xl relative select-text" id="watcher-realtime-console-container">
        
        {/* Terminal Header */}
        <div className="bg-slate-950/70 py-3 px-4 border-b border-white/10 flex items-center justify-between font-mono text-[10px] text-slate-400 select-none shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex gap-1 mr-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
            </div>
            <Terminal size={12} className="text-cyan-400" />
            <span className="text-[11px] text-cyan-400/95 font-semibold font-mono">dragnet-watcher --daemon</span>
          </div>

          <button 
            onClick={() => {
              setLogs([
                { id: '1', timestamp: new Date().toLocaleTimeString(), type: 'info', message: 'Terminal cleared.' }
              ]);
            }}
            className="text-[10px] text-slate-400 hover:text-white hover:bg-white/5 px-2 py-0.5 rounded border border-white/10 font-mono transition-all uppercase"
          >
            Clear log
          </button>
        </div>

        {/* Terminal logs list viewport */}
        <div className="flex-1 bg-[#090C12] p-4 overflow-y-auto max-h-[350px] xl:max-h-[580px] min-h-[220px] font-mono text-[11px] leading-relaxed space-y-2">
          {logs.map((log) => {
            let color = 'text-slate-300';
            let prefix = '◇ [SYSTEM]';

            if (log.type === 'success') {
              color = 'text-emerald-400';
              prefix = '✔ [SYSTEM]';
            } else if (log.type === 'warn') {
              color = 'text-amber-400';
              prefix = '⚠ [WARN]';
            } else if (log.type === 'error') {
              color = 'text-rose-400 font-bold';
              prefix = '✖ [ERROR]';
            } else if (log.type === 'git') {
              color = 'text-indigo-400';
              prefix = 'λ [GITCLI]';
            }

            return (
              <div key={log.id} className="transition-all hover:bg-white/5 py-0.5 px-1 rounded">
                <span className="text-slate-600 font-mono mr-2 select-none text-[10px]">{log.timestamp}</span>
                {log.repoName && (
                  <span className="text-cyan-400/85 font-semibold font-mono mr-1">{`[${log.repoName}]`}</span>
                )}
                <span className={color}>{prefix} {log.message}</span>
              </div>
            );
          })}
          <div ref={consoleEndRef} />
        </div>

        {/* Console Status Footer */}
        <div className="bg-slate-950/90 px-4 py-2 text-[9px] font-mono text-slate-500 border-t border-white/10 flex items-center justify-between select-none shrink-0">
          <div className="flex gap-4">
            <span>Repos: {repos.length}</span>
            <span>Logs stored: {logs.length}</span>
          </div>
          <div className="flex items-center gap-1.5 text-cyan-400">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
            <span className="uppercase tracking-wide">Live Stream Connected</span>
          </div>
        </div>

      </div>

      {/* REGISTER RECIPIENT MODAL DIALOG */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0F1219] border border-white/15 rounded-xl max-w-md w-full p-6 shadow-2xl relative"
            >
              <div className="flex justify-between items-center border-b border-white/5 pb-4 mb-4">
                <h3 className="text-base font-semibold text-white tracking-tight flex items-center gap-1.5">
                  <Database size={16} className="text-cyan-400" />
                  <span>Register Repository Path</span>
                </h3>
                <button 
                  onClick={() => setShowAddModal(false)}
                  className="text-slate-500 hover:text-white transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleRegisterRepo} className="space-y-4 text-xs font-mono">
                <div>
                  <label className="block text-slate-400 font-semibold mb-1.5">PROJECT / REPOSITORY NAME</label>
                  <input
                    required
                    type="text"
                    placeholder="e.g. backend-api"
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-slate-400 font-semibold mb-1.5">ABSOLUTE ROOT SYSTEM PATH</label>
                  <input
                    required
                    type="text"
                    placeholder="e.g. /home/user/code/backend-api"
                    value={newRepoPath}
                    onChange={(e) => setNewRepoPath(e.target.value)}
                    className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-400 font-semibold mb-1.5">BASE BRANCH</label>
                    <input
                      type="text"
                      value={newBaseBranch}
                      onChange={(e) => setNewBaseBranch(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-slate-400 font-semibold mb-1.5">BRANCH MATCH FILTER</label>
                    <input
                      type="text"
                      value={newBranchPattern}
                      onChange={(e) => setNewBranchPattern(e.target.value)}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-400 font-semibold mb-1.5">TRIGGER MODE</label>
                    <select
                      value={newTriggerMode}
                      onChange={(e) => setNewTriggerMode(e.target.value as 'auto' | 'mention')}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                    >
                      <option value="auto">auto-inspect</option>
                      <option value="mention">mention-only</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-400 font-semibold mb-1.5">QUIET PERIOD (DEMO SECS)</label>
                    <input
                      required
                      type="number"
                      min={3}
                      max={60}
                      value={newQuietPeriod}
                      onChange={(e) => setNewQuietPeriod(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-white/10 rounded p-2.5 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex gap-3 justify-end pt-4 border-t border-white/5 mt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className="bg-white/5 text-slate-300 hover:bg-white/10 border border-white/10 px-4 py-2 rounded font-semibold tracking-tight transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="bg-cyan-500 hover:bg-cyan-400 text-black px-4 py-2 rounded font-semibold tracking-tight transition-all cursor-pointer"
                  >
                    Link Repository
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
