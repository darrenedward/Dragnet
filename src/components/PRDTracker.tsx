import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CheckCircle2, 
  Circle, 
  Plus, 
  Trash2, 
  Sliders, 
  Sparkles, 
  ListTodo, 
  Zap, 
  TrendingUp, 
  Clock, 
  BookOpen, 
  Check, 
  Maximize2,
  FileCode,
  ShieldCheck,
  Award,
  ArrowRight,
  RefreshCw,
  MoreVertical,
  Layers,
  ChevronDown,
  ChevronRight
} from 'lucide-react';

export interface PrdTask {
  id: string;
  phaseId: string;
  title: string;
  description: string;
  isCompleted: boolean;
  assignedTo: string;
  urgency: 'low' | 'medium' | 'high';
  estimatedMinutes: number;
}

export interface PrdPhase {
  id: string;
  name: string;
  description: string;
  icon: string;
  isUnlocked: boolean;
}

export default function PRDTracker() {
  // Pre-load standard phases representing the full Dragnet PRD specification
  const initialPhases: PrdPhase[] = [
    {
      id: 'phase1',
      name: 'Phase 1: Local Watcher Core',
      description: 'Directory scanning of local git projects & branch lifecycle tracking',
      icon: 'Layers',
      isUnlocked: true
    },
    {
      id: 'phase2',
      name: 'Phase 2: Pluggable AI Review Pipeline',
      description: 'Diff extractors, system prompts, & cloud/local LLM coordination',
      icon: 'Sparkles',
      isUnlocked: true
    },
    {
      id: 'phase3',
      name: 'Phase 3: Interactive Reporting & Viewers',
      description: 'Report generators, issue alert cards, and markdown compilation',
      icon: 'FileCode',
      isUnlocked: true
    },
    {
      id: 'phase4',
      name: 'Phase 4: Daemon & Playground Controls',
      description: 'User control panels, path linkers, and daemon simulator loop',
      icon: 'Sliders',
      isUnlocked: true
    }
  ];

  // Pre-load comprehensive tasks reflecting the exact functional scope of Dragnet
  const initialTasks: PrdTask[] = [
    // Phase 1 tasks
    {
      id: 'task-1-1',
      phaseId: 'phase1',
      title: 'Scan active local git refs',
      description: 'Monitor .git/refs/heads directory to automatically detect active branches.',
      isCompleted: true,
      assignedTo: 'Daemon Parser',
      urgency: 'high',
      estimatedMinutes: 60
    },
    {
      id: 'task-1-2',
      phaseId: 'phase1',
      title: 'Create project registration layout',
      description: 'Persist registered project records with localized absolute disk paths.',
      isCompleted: true,
      assignedTo: 'Workspace Manager',
      urgency: 'high',
      estimatedMinutes: 45
    },
    {
      id: 'task-1-3',
      phaseId: 'phase1',
      title: 'Implement stabilization timer',
      description: 'Trigger quiet-period countdown that waits N-seconds of silent local activity before initiating review.',
      isCompleted: true,
      assignedTo: 'Scheduler',
      urgency: 'medium',
      estimatedMinutes: 30
    },

    // Phase 2 tasks
    {
      id: 'task-2-1',
      phaseId: 'phase2',
      title: 'Support OpenAI-compatible & Ollama endpoints',
      description: 'Create a pluggable router to switch LLM prompt pipelines from public cloud keys to local docker engines.',
      isCompleted: true,
      assignedTo: 'LLM Router',
      urgency: 'high',
      estimatedMinutes: 90
    },
    {
      id: 'task-2-2',
      phaseId: 'phase2',
      title: 'Apply Git diff system prompts',
      description: 'Design robust code context layouts instructing models to focus exclusively on correctness, injections, and complexity.',
      isCompleted: true,
      assignedTo: 'AI Specialist',
      urgency: 'high',
      estimatedMinutes: 45
    },
    {
      id: 'task-2-3',
      phaseId: 'phase2',
      title: 'Detect @PRBot review & metadata tags',
      description: 'Check commit log messages and scan the staging area for hook files to force manual review requests.',
      isCompleted: true,
      assignedTo: 'Daemon Trigger',
      urgency: 'medium',
      estimatedMinutes: 40
    },

    // Phase 3 tasks
    {
      id: 'task-3-1',
      phaseId: 'phase3',
      title: 'Build structured issue categorization schema',
      description: 'Format LLM payloads into secure JSON objects grouping events under Security, Correctness, and Style rules.',
      isCompleted: true,
      assignedTo: 'API Schema Node',
      urgency: 'high',
      estimatedMinutes: 50
    },
    {
      id: 'task-3-2',
      phaseId: 'phase3',
      title: 'Implement interactive code card indicators',
      description: 'Render responsive, colorful report views overlaying recommended fixes and source diff code snippets.',
      isCompleted: true,
      assignedTo: 'UI Specialist',
      urgency: 'medium',
      estimatedMinutes: 75
    },
    {
      id: 'task-3-3',
      phaseId: 'phase3',
      title: 'Compile and export report Markdown',
      description: 'Allow local download or write access of structured markdown text files matching specific user formats.',
      isCompleted: false,
      assignedTo: 'Report Compiler',
      urgency: 'low',
      estimatedMinutes: 30
    },

    // Phase 4 tasks
    {
      id: 'task-4-1',
      phaseId: 'phase4',
      title: 'Playground control buttons',
      description: 'Inject user controls supporting play/pause activities for parallel background loops.',
      isCompleted: true,
      assignedTo: 'Daemon Controller',
      urgency: 'high',
      estimatedMinutes: 40
    },
    {
      id: 'task-4-2',
      phaseId: 'phase4',
      title: 'Configurable polling rates & sliders',
      description: 'Support manual configuration of interval frequencies to simulate high performance or low CPU profiles.',
      isCompleted: true,
      assignedTo: 'Dashboard Lead',
      urgency: 'low',
      estimatedMinutes: 25
    },
    {
      id: 'task-4-4',
      phaseId: 'phase4',
      title: 'Interactive Git event CLI simulator',
      description: 'Create simulated git inputs allowing safe, live experimentation with branch creations and commit patterns.',
      isCompleted: true,
      assignedTo: 'CLI Dev',
      urgency: 'high',
      estimatedMinutes: 60
    }
  ];

  // Try to load state from LocalStorage, fallback to constants
  const [phases] = useState<PrdPhase[]>(() => {
    const saved = localStorage.getItem('dragnet_prd_phases');
    return saved ? JSON.parse(saved) : initialPhases;
  });

  const [tasks, setTasks] = useState<PrdTask[]>(() => {
    const saved = localStorage.getItem('dragnet_prd_tasks');
    return saved ? JSON.parse(saved) : initialTasks;
  });

  // Track state persistence
  useEffect(() => {
    localStorage.setItem('dragnet_prd_tasks', JSON.stringify(tasks));
  }, [tasks]);

  // Collapsed phases state
  const [collapsedPhases, setCollapsedPhases] = useState<Record<string, boolean>>({
    phase3: false,
    phase4: false
  });

  // Task creation state
  const [selectedPhaseForNewTask, setSelectedPhaseForNewTask] = useState<string>('phase2');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskUrgency, setNewTaskUrgency] = useState<'low' | 'medium' | 'high'>('medium');
  const [newTaskEst, setNewTaskEst] = useState(30);

  // Filter view state
  const [filterMode, setFilterMode] = useState<'all' | 'pending' | 'completed'>('all');

  // Toggle single task completed status
  const handleToggleTask = (taskId: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, isCompleted: !t.isCompleted };
      }
      return t;
    }));
  };

  // Add a new task dynamically to target phase
  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    const newTask: PrdTask = {
      id: `task-custom-${Date.now()}`,
      phaseId: selectedPhaseForNewTask,
      title: newTaskTitle.trim(),
      description: newTaskDesc.trim() || 'Custom user-specified implementation criteria.',
      isCompleted: false,
      assignedTo: 'AI Core / User',
      urgency: newTaskUrgency,
      estimatedMinutes: newTaskEst
    };

    setTasks(prev => [...prev, newTask]);
    setNewTaskTitle('');
    setNewTaskDesc('');
    setNewTaskUrgency('medium');
    setNewTaskEst(30);
  };

  // Delete a customized task
  const handleDeleteTask = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
  };

  // Mass mark all tasks in a phase as complete helper or toggle
  const toggleAllPhaseTasks = (phaseId: string, value: boolean) => {
    setTasks(prev => prev.map(t => {
      if (t.phaseId === phaseId) {
        return { ...t, isCompleted: value };
      }
      return t;
    }));
  };

  // Toggle collapse visual element
  const toggleCollapse = (phaseId: string) => {
    setCollapsedPhases(prev => ({ ...prev, [phaseId]: !prev[phaseId] }));
  };

  // Calculations for KPI boards
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.isCompleted).length;
  const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const remainingMinutes = tasks.filter(t => !t.isCompleted).reduce((acc, t) => acc + t.estimatedMinutes, 0);

  // Grouped parameters helper
  const getPhaseStats = (phaseId: string) => {
    const phaseTasks = tasks.filter(t => t.phaseId === phaseId);
    const total = phaseTasks.length;
    const completed = phaseTasks.filter(t => t.isCompleted).length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, pct };
  };

  return (
    <div className="flex flex-col gap-6 w-full h-full select-none" id="prd-roadmap-tracker-view">
      
      {/* Top statistics dashboard strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        {/* Metric 1 */}
        <div className="bg-[#0F1219]/90 border border-white/10 rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-colors" />
          <div className="flex gap-3.5 items-center">
            <div className="w-10 h-10 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center border border-cyan-500/20">
              <ListTodo size={20} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider block">Overall Progress</span>
              <span className="text-xl font-bold font-sans text-white tracking-tight">{completionPercentage}%</span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-xs font-mono font-bold text-slate-400 block">{completedTasks} / {totalTasks}</span>
            <span className="text-[9px] uppercase font-semibold text-slate-500">Tasks Saved</span>
          </div>
        </div>

        {/* Metric 2 */}
        <div className="bg-[#0F1219]/90 border border-white/10 rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-2xl group-hover:bg-amber-500/10 transition-colors" />
          <div className="flex gap-3.5 items-center">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center border border-amber-500/20">
              <Clock size={19} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider block">Estimated Remaining</span>
              <span className="text-xl font-bold font-sans text-white tracking-tight">
                {remainingMinutes > 60 ? `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m` : `${remainingMinutes} min`}
              </span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-xs font-mono text-amber-400 font-bold block">{tasks.filter(t => !t.isCompleted).length} tasks left</span>
            <span className="text-[9px] uppercase font-semibold text-slate-500">Estimated Effort</span>
          </div>
        </div>

        {/* Metric 3 */}
        <div className="bg-[#0F1219]/90 border border-white/10 rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-colors" />
          <div className="flex gap-3.5 items-center">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center border border-emerald-500/20">
              <ShieldCheck size={20} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider block">High Priority Focus</span>
              <span className="text-xl font-bold font-sans text-white tracking-tight">
                {tasks.filter(t => t.urgency === 'high' && !t.isCompleted).length} pending
              </span>
            </div>
          </div>
          <div className="text-right">
            <span className="text-xs font-mono text-emerald-400 font-bold block">
              {tasks.filter(t => t.urgency === 'high' && t.isCompleted).length} resolved
            </span>
            <span className="text-[9px] uppercase font-semibold text-slate-500">Core Architecture</span>
          </div>
        </div>

        {/* Metric 4 */}
        <div className="bg-[#0F1219]/90 border border-white/10 rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-violet-500/5 rounded-full blur-2xl group-hover:bg-violet-500/10 transition-colors" />
          <div className="flex gap-3.5 items-center">
            <div className="w-10 h-10 rounded-lg bg-violet-400/10 text-violet-400 flex items-center justify-center border border-violet-400/20">
              <Award size={20} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider block">Current Status</span>
              <span className="text-xl font-bold font-sans text-white tracking-tight">Active Implementer</span>
            </div>
          </div>
          <div className="text-right text-[10px] font-mono text-violet-400">
            <span className="block font-bold">Dragnet MVP</span>
            <span className="text-[9px] text-slate-500 uppercase">Interactive roadmap</span>
          </div>
        </div>

      </div>

      {/* Main Roadmap content grid */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        
        {/* Left Column: List of Phases and collapsible tasks */}
        <div className="flex-1 flex flex-col gap-5 w-full">
          
          {/* Filters strip */}
          <div className="flex items-center justify-between bg-slate-900/60 p-2 border border-white/5 rounded-lg">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500 font-mono uppercase px-2">Show:</span>
              <button
                onClick={() => setFilterMode('all')}
                className={`px-3 py-1 text-xs rounded transition-all cursor-pointer ${filterMode === 'all' ? 'bg-cyan-500 text-black font-semibold' : 'text-slate-400 hover:text-white'}`}
              >
                All Scope ({tasks.length})
              </button>
              <button
                onClick={() => setFilterMode('pending')}
                className={`px-3 py-1 text-xs rounded transition-all cursor-pointer ${filterMode === 'pending' ? 'bg-amber-400 text-black font-semibold' : 'text-slate-400 hover:text-white'}`}
              >
                Pending ({tasks.filter(t => !t.isCompleted).length})
              </button>
              <button
                onClick={() => setFilterMode('completed')}
                className={`px-3 py-1 text-xs rounded transition-all cursor-pointer ${filterMode === 'completed' ? 'bg-emerald-400 text-black font-semibold' : 'text-slate-400 hover:text-white'}`}
              >
                Completed ({tasks.filter(t => t.isCompleted).length})
              </button>
            </div>

            <button 
              onClick={() => {
                if (window.confirm("Restore implementation state back to default? All modified values will be soft reset.")) {
                  localStorage.removeItem('dragnet_prd_tasks');
                  setTasks(initialTasks);
                }
              }}
              className="text-[10px] font-mono text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 transition-colors border border-white/10 px-2 py-1 rounded"
            >
              Reset Roadmap
            </button>
          </div>

          {/* Render Phases */}
          {phases.map((phase) => {
            const phaseStats = getPhaseStats(phase.id);
            const isCollapsed = collapsedPhases[phase.id] || false;

            // Only show phase if it has matching filtered tasks
            const phaseTasks = tasks.filter(t => t.phaseId === phase.id);
            const filteredTasks = phaseTasks.filter(t => {
              if (filterMode === 'pending') return !t.isCompleted;
              if (filterMode === 'completed') return t.isCompleted;
              return true;
            });

            if (filteredTasks.length === 0 && filterMode !== 'all') return null;

            return (
              <div 
                key={phase.id} 
                className={`bg-[#0F1219]/90 border rounded-xl overflow-hidden shadow-xl transition-all ${
                  phaseStats.pct === 100 
                    ? 'border-emerald-500/20 bg-emerald-500/[0.01]' 
                    : 'border-white/10'
                }`}
              >
                {/* Phase Header banner */}
                <div 
                  className="px-4 py-3 bg-slate-950/60 border-b border-white/5 flex flex-wrap items-center justify-between gap-3 cursor-pointer select-none"
                  onClick={() => toggleCollapse(phase.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <button className="text-slate-500 hover:text-white shrink-0">
                      {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </button>
                    
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white tracking-tight">{phase.name}</span>
                        {phaseStats.pct === 100 && (
                          <span className="text-[9px] bg-emerald-500/10 text-emerald-400 font-mono px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold uppercase">
                            ✓ Phase Complete
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400 block truncate max-w-md mt-0.5">
                        {phase.description}
                      </span>
                    </div>
                  </div>

                  {/* Right: Progress bar & Toggle All link */}
                  <div className="flex items-center gap-3.5 ml-auto">
                    <div className="flex flex-col items-end text-right shrink-0">
                      <span className="text-xs font-mono text-slate-300 font-semibold">{phaseStats.pct}%</span>
                      <span className="text-[9px] text-slate-500 font-mono">({phaseStats.completed} / {phaseStats.total}) done</span>
                    </div>

                    {/* Progress Slider Pill */}
                    <div className="w-20 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-white/5">
                      <div 
                        className={`h-full rounded-full transition-all duration-300 ${phaseStats.pct === 100 ? 'bg-emerald-400' : 'bg-cyan-400'}`}
                        style={{ width: `${phaseStats.pct}%` }}
                      />
                    </div>

                    <div className="flex items-center gap-1.5 border-l border-white/5 pl-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAllPhaseTasks(phase.id, true);
                        }}
                        className="text-[9px] text-cyan-400 hover:underline font-mono uppercase bg-cyan-400/5 px-1.5 py-0.5 rounded"
                      >
                        All Complete
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAllPhaseTasks(phase.id, false);
                        }}
                        className="text-[9px] text-slate-500 hover:underline font-mono uppercase bg-slate-900 px-1.5 py-0.5 rounded"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>

                {/* Collapsible Tasks List Area */}
                <AnimatePresence initial={false}>
                  {!isCollapsed && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="divide-y divide-white/5"
                    >
                      {filteredTasks.length === 0 ? (
                        <div className="p-5 text-center text-slate-500 text-xs">
                          No filtered tasks found in this phase.
                        </div>
                      ) : (
                        filteredTasks.map((task) => {
                          return (
                            <div 
                              key={task.id}
                              className={`p-4 flex items-start justify-between gap-4 transition-all hover:bg-white/5 select-none ${
                                task.isCompleted ? 'bg-emerald-500/[0.015] opacity-65' : ''
                              }`}
                            >
                              <div className="flex items-start gap-3 min-w-0">
                                {/* Interactive Toggle Icon */}
                                <button
                                  onClick={() => handleToggleTask(task.id)}
                                  className={`mt-0.5 shrink-0 transition-colors cursor-pointer ${
                                    task.isCompleted ? 'text-emerald-400' : 'text-slate-500 hover:text-white'
                                  }`}
                                  title={task.isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
                                >
                                  {task.isCompleted ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                                </button>

                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span 
                                      className={`text-xs font-semibold tracking-tight cursor-pointer ${
                                        task.isCompleted ? 'text-slate-400 line-through' : 'text-slate-100'
                                      }`}
                                      onClick={() => handleToggleTask(task.id)}
                                    >
                                      {task.title}
                                    </span>

                                    {/* Urgency Badge */}
                                    <span className={`text-[8px] font-mono font-bold px-1 py-0.2 rounded uppercase ${
                                      task.urgency === 'high' 
                                        ? 'bg-rose-500/15 text-rose-400' 
                                        : task.urgency === 'medium' 
                                        ? 'bg-amber-500/10 text-amber-400' 
                                        : 'bg-slate-800 text-slate-400'
                                    }`}>
                                      {task.urgency}
                                    </span>

                                    <span className="text-[10px] text-slate-500 font-mono">
                                      {task.estimatedMinutes} min
                                    </span>
                                  </div>

                                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                                    {task.description}
                                  </p>

                                  <div className="flex items-center gap-2 mt-2 text-[10px] font-mono text-slate-500">
                                    <span>Assigned:</span>
                                    <span className="text-slate-400">{task.assignedTo}</span>
                                  </div>
                                </div>
                              </div>

                              {/* Right utility buttons: Delete if custom */}
                              {task.id.startsWith('task-custom-') && (
                                <button
                                  onClick={() => handleDeleteTask(task.id)}
                                  className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-rose-500/5 transition-colors cursor-pointer"
                                  title="Delete custom task"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}

        </div>

        {/* Right Column: Custom task registry form & help notes */}
        <div className="w-full lg:w-80 shrink-0 flex flex-col gap-5">
          
          {/* Add a customized task form board */}
          <div className="bg-[#0F1219]/90 border border-white/10 rounded-xl p-4.5 shadow-xl">
            <h4 className="text-xs font-bold text-white tracking-tight flex items-center gap-1.5 border-b border-white/5 pb-2.5 mb-3 uppercase">
              <Plus size={14} className="text-cyan-400 animate-pulse" />
              <span>Add Custom Project Task</span>
            </h4>

            <form onSubmit={handleAddTask} className="flex flex-col gap-3 text-xs font-mono">
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase text-[9px]">Target Phase</label>
                <select 
                  value={selectedPhaseForNewTask}
                  onChange={(e) => setSelectedPhaseForNewTask(e.target.value)}
                  className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden select-none focus:border-cyan-500 transition-colors"
                >
                  {phases.map(p => (
                    <option key={p.id} value={p.id}>{p.name.split(':')[0]}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase text-[9px]">Task Name / Title</label>
                <input 
                  required
                  type="text"
                  placeholder="e.g. Integrate git-cliff templates"
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 placeholder-slate-600 outline-hidden focus:border-cyan-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase text-[9px]">Task Detail Description</label>
                <textarea 
                  rows={2}
                  placeholder="What specifically needs to be checked or setup for compliance?"
                  value={newTaskDesc}
                  onChange={(e) => setNewTaskDesc(e.target.value)}
                  className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 placeholder-slate-600 outline-hidden resize-none focus:border-cyan-500 transition-colors"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase text-[9px]">Priority</label>
                  <select 
                    value={newTaskUrgency}
                    onChange={(e) => setNewTaskUrgency(e.target.value as 'low' | 'medium' | 'high')}
                    className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden cursor-pointer focus:border-cyan-500 transition-colors"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase text-[9px]">Est. Time (min)</label>
                  <input 
                    required
                    type="number"
                    min={5}
                    max={240}
                    value={newTaskEst}
                    onChange={(e) => setNewTaskEst(Number(e.target.value))}
                    className="font-mono w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!newTaskTitle.trim()}
                className="mt-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:hover:bg-cyan-500 text-black py-2 rounded text-xs font-semibold cursor-pointer select-none transition-colors w-full text-center block"
              >
                Register Phase Task
              </button>
            </form>
          </div>

          {/* Quick-Help panel info block */}
          <div className="bg-slate-950/60 border border-white/5 rounded-xl p-4 flex flex-col gap-3">
            <h5 className="text-[10px] uppercase font-mono tracking-wider text-slate-400 font-bold flex items-center gap-1.5">
              <Zap size={11} className="text-amber-400" />
              <span>Solo-First Strategy</span>
            </h5>
            <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
              Dragnet starts with the core offline-first watcher and local reviewer. Check off completed items directly as you build the binary and daemon loops.
            </p>
            <div className="border-t border-white/5 mt-1 pt-2.5 flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span>Task List Draft: </span>
              <span className="text-cyan-400">v1.1 Live Tracker</span>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
