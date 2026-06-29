import React, { useState, useEffect } from 'react';
import { toast } from '../lib/toast';
import {
  Network,
  Search,
  Settings,
  RefreshCw,
  FileCode,
  Layers,
  HelpCircle,
  ArrowRight,
  FileText,
  Info,
  CheckCircle,
  Code,
  ChevronRight,
  Loader2,
} from 'lucide-react';

interface CodebaseGraphProps {
  repoId: string;
  repoName: string;
  /** Fired when an index run completes successfully so the parent can refresh indexedAt. */
  onIndexComplete?: () => void;
}

interface SymbolNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  lineStart: number;
  signature: string;
}

interface EdgeLink {
  id: string;
  source: string;
  target: string | null;
  targetRaw: string;
  kind: string;
  line: number;
  filePath: string;
}

export default function CodebaseGraph({ repoId, repoName, onIndexComplete }: CodebaseGraphProps) {
  const [symbols, setSymbols] = useState<SymbolNode[]>([]);
  const [edges, setEdges] = useState<EdgeLink[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexStats, setIndexStats] = useState<any | null>(null);
  const [selectedSymbolId, setSelectedSymbolId] = useState<string | null>(null);
  const [activeLangFilter, setActiveLangFilter] = useState<string>('All');

  // Load call graph data (symbols + edges)
  const fetchData = async () => {
    if (!repoId) return;
    try {
      const symRes = await fetch(`/api/repos/${repoId}/symbols`);
      if (symRes.ok) {
        const symData = await symRes.json();
        setSymbols(symData);
      }
      const edgeRes = await fetch(`/api/repos/${repoId}/edges`);
      if (edgeRes.ok) {
        const edgeData = await edgeRes.json();
        setEdges(edgeData);
      }
    } catch (err) {
      console.error("Failed fetching codebase graph information:", err);
    }
  };

  useEffect(() => {
    fetchData();
    setIndexStats(null);
  }, [repoId]);

  // Trigger manual codebase-wide AST parsing indexing run.
  // The route returns immediately (202-style); actual work runs detached and
  // the 15s poller in useDashboardData flips `indexedAt` which surfaces here
  // via onIndexComplete. We keep isIndexing true locally until we detect
  // completion by polling the repo's indexedAt field.
  const handleStartIndexing = async () => {
    setIsIndexing(true);
    setIndexStats(null);
    try {
      const res = await fetch(`/api/repos/${repoId}/index`, {
        method: "POST"
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        // Server returned { started: true } — work is running in background.
        // Poll /api/repos every 5s until indexedAt appears, then fire completion.
        const poll = async () => {
          for (let i = 0; i < 600; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const r = await fetch(`/api/repos/${repoId}`);
              if (r.ok) {
                const repo = await r.json();
                if (repo?.indexedAt) {
                  setIndexStats({
                    elapsedMs: 0,
                    filesProcessed: 0,
                    symbolsExtracted: 0,
                    background: true,
                  });
                  await fetchData();
                  onIndexComplete?.();
                  setIsIndexing(false);
                  return;
                }
              }
            } catch {}
          }
          setIsIndexing(false);
        };
        poll();
      } else if (res.status === 409 && data.error === "ALREADY_INDEXING") {
        // Already running — keep the in-progress banner visible.
      } else {
        toast.error(
          `Indexing failed (${res.status}): ${data.error || res.statusText}. Check the dev server console for details.`,
        );
        setIsIndexing(false);
      }
    } catch (err: any) {
      toast.error("Failed to parse AST structure: " + (err?.message ?? "unknown error"));
      setIsIndexing(false);
    }
  };

  // Compute stats
  const uniqueFiles = Array.from(new Set(symbols.map(s => s.filePath)));
  const totalFunctions = symbols.filter(s => s.kind === 'function' || s.kind === 'method').length;
  const totalClasses = symbols.filter(s => s.kind === 'class').length;
  
  // Filter symbols based on search and filters
  const filteredSymbols = symbols.filter(s => {
    const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          s.filePath.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          s.kind.toLowerCase().includes(searchTerm.toLowerCase());
    if (activeLangFilter === 'All') return matchesSearch;
    if (activeLangFilter === 'Python') return matchesSearch && s.filePath.endsWith('.py');
    if (activeLangFilter === 'Rust') return matchesSearch && s.filePath.endsWith('.rs');
    if (activeLangFilter === 'TypeScript/JS') return matchesSearch && (s.filePath.endsWith('.ts') || s.filePath.endsWith('.tsx') || s.filePath.endsWith('.js') || s.filePath.endsWith('.jsx'));
    if (activeLangFilter === 'Go') return matchesSearch && s.filePath.endsWith('.go');
    return matchesSearch;
  });

  const selectedSymbol = symbols.find(s => s.id === selectedSymbolId);

  // Find incoming callers of selected symbol
  const callers = selectedSymbolId ? edges.filter(e => e.target === selectedSymbolId) : [];
  
  // Find outgoing callees called within this symbol's body scope
  // For simplicity, find edges with source === selectedSymbolId
  const callees = selectedSymbolId ? edges.filter(e => e.source === selectedSymbolId) : [];

  return (
    <div className="flex flex-col flex-1 overflow-hidden" id="workspace-graph-view">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
        {/* Metric cards */}
        <div className="p-4 bg-slate-900/60 border border-white/5 rounded-xl flex items-center gap-3">
          <div className="p-2.5 bg-cyan-500/10 text-cyan-400 rounded-lg">
            <Layers size={18} />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase font-mono font-bold leading-none">Codebase Files parsed</div>
            <div className="text-xl font-bold text-white mt-1.5 font-mono">{uniqueFiles.length}</div>
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-white/5 rounded-xl flex items-center gap-3">
          <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-lg">
            <Code size={18} />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase font-mono font-bold leading-none">AST Symbols Analyzed</div>
            <div className="text-xl font-bold text-white mt-1.5 font-mono">{symbols.length}</div>
          </div>
        </div>

        <div className="p-4 bg-slate-900/60 border border-white/5 rounded-xl flex items-center gap-3">
          <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-lg">
            <Network size={18} />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 uppercase font-mono font-bold leading-none">Call Graph Edges</div>
            <div className="text-xl font-bold text-white mt-1.5 font-mono">{edges.length}</div>
          </div>
        </div>

        {/* Index trigger buttons */}
        <div className={`p-3 bg-[#0F1219] border rounded-xl flex items-center justify-between transition-colors ${
          isIndexing ? 'border-cyan-500/40 shadow-[0_0_18px_rgba(6,182,212,0.18)]' : 'border-white/10'
        }`}>
          <div className="flex-1 min-w-0 pr-2">
            <div className="text-[9px] text-slate-400 uppercase font-mono font-semibold truncate leading-none">
              {isIndexing ? 'Indexing in progress…' : 'Codebase AST sync'}
            </div>
            <div className="text-[10px] text-slate-500 mt-1 truncate">
              {isIndexing ? 'Parsing files & embedding call paths' : 'Analyze files & extract call paths'}
            </div>
          </div>
          <button
            disabled={isIndexing}
            onClick={handleStartIndexing}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 shrink-0 ${
              isIndexing
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 cursor-wait'
                : 'bg-cyan-500 text-black hover:bg-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.2)] cursor-pointer'
            }`}
          >
            {isIndexing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            <span>{isIndexing ? 'Indexing…' : 'Index Code'}</span>
          </button>
        </div>
      </div>

      {/* Full-width indexing progress banner — much more obvious than just the button label */}
      {isIndexing && (
        <div className="p-3.5 bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 rounded-xl text-xs font-mono mb-4 flex items-center gap-3 animate-fadeIn">
          <Loader2 size={16} className="text-cyan-300 animate-spin shrink-0" />
          <div className="flex-1">
            <strong className="text-cyan-200">Indexing in progress.</strong> Parsing files, extracting AST symbols, and embedding call paths. The PR scan unlocks automatically once this completes.
          </div>
          <span className="text-[10px] text-cyan-400/70 uppercase tracking-wider shrink-0 hidden sm:inline">please wait…</span>
        </div>
      )}

      {indexStats && !isIndexing && (
        <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-xl text-xs font-mono mb-4 flex items-center justify-between animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-emerald-400 shrink-0" />
            <span>
              {indexStats.background ? (
                <>
                  <strong className="text-emerald-200">Indexing complete.</strong> Codebase AST graph is fresh. PR review scan is now unlocked.
                </>
              ) : (
                <>
                  <strong className="text-emerald-200">Indexing complete.</strong> Parsed <strong>{indexStats.filesProcessed} files</strong>, mapped <strong>{indexStats.symbolsExtracted} call sites</strong> in <strong>{indexStats.elapsedMs}ms</strong>. PR review scan is now unlocked.
                </>
              )}
            </span>
          </div>
          <button onClick={() => setIndexStats(null)} className="text-slate-400 hover:text-white shrink-0">✕</button>
        </div>
      )}

      {/* Main split work-desk */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-hidden min-h-0">
        {/* Left Column: List & Filter */}
        <div className="lg:col-span-5 bg-[#0F1219] border border-white/10 rounded-xl flex flex-col overflow-hidden min-h-0">
          <div className="p-3.5 border-b border-white/5 space-y-3 shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-slate-500" size={13} />
              <input 
                type="text"
                placeholder="Search symbol, class, kind, or filename..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-950 border border-white/5 hover:border-white/10 focus:border-cyan-500/55 rounded-lg pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 font-mono focus:outline-hidden transition-all"
              />
            </div>

            {/* Language filter pill row */}
            <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
              {['All', 'Python', 'Rust', 'TypeScript/JS', 'Go'].map((lang) => (
                <button
                  key={lang}
                  onClick={() => setActiveLangFilter(lang)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono whitespace-nowrap shrink-0 transition-colors ${
                    activeLangFilter === lang 
                      ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20' 
                      : 'bg-slate-950 text-slate-400 border border-transparent hover:text-white'
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>
          </div>

          {/* List display */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5" id="symbols-scrollable-container">
            {filteredSymbols.length === 0 ? (
              <div className="py-20 text-center text-xs text-slate-600 font-mono">
                No indexed symbols match your active query.
              </div>
            ) : (
              filteredSymbols.map((sym) => {
                const isSelected = sym.id === selectedSymbolId;
                const fileParts = sym.filePath.split('/');
                const displayFile = fileParts[fileParts.length - 1];
                
                return (
                  <button
                    key={sym.id}
                    onClick={() => setSelectedSymbolId(sym.id)}
                    className={`w-full text-left p-3 rounded-lg border text-xs font-mono transition-all flex items-start justify-between gap-3 ${
                      isSelected 
                        ? 'bg-cyan-500/10 border-cyan-500/30 text-white shadow-[inset_0_1px_4px_rgba(6,182,212,0.05)]' 
                        : 'bg-slate-900/40 border-transparent hover:bg-slate-900 text-slate-300 hover:text-white'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold truncate text-[13px]">{sym.name}</span>
                        <span className={`text-[8px] px-1 py-0.2 rounded font-extrabold uppercase font-mono tracking-wider ${
                          sym.kind === 'class' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-cyan-500/20 text-cyan-400'
                        }`}>
                          {sym.kind}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 truncate mt-1 flex items-center gap-1">
                        <FileCode size={11} className="text-slate-500" />
                        <span className="truncate" title={sym.filePath}>{sym.filePath} : Line {sym.lineStart}</span>
                      </div>
                    </div>
                    <ChevronRight size={13} className={`self-center text-slate-500 transform transition-transform ${isSelected ? 'rotate-90 text-cyan-400' : ''}`} />
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Codebase Call Graph Explorer Flow */}
        <div className="lg:col-span-7 bg-[#0F1219] border border-white/10 rounded-xl flex flex-col overflow-hidden min-h-0">
          <div className="p-3.5 border-b border-white/5 bg-slate-950/20 shrink-0 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Network size={14} className="text-indigo-400" />
              <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">Multi-Hop Call Propagation Tracing</span>
            </div>
            <div className="text-[10px] text-slate-500 italic font-mono uppercase tracking-wide">AST Relation Graph</div>
          </div>

          {!selectedSymbol ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-slate-950/25">
              <div className="w-12 h-12 rounded-full border border-dashed border-white/10 text-slate-500 flex items-center justify-center mb-3">
                <Network size={22} className="text-slate-500 animate-pulse" />
              </div>
              <h4 className="text-xs font-mono font-bold text-slate-300">Select an AST Symbol representation</h4>
              <p className="text-[11px] text-slate-500 font-mono mt-1 w-72">
                Click any parsed method or function from the left index panel to map callers and dependencies instantly.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-4" id="graph-explorer-workspace">
              {/* Core Symbol details */}
              <div className="p-4 bg-slate-900/60 border border-cyan-500/10 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[9px] uppercase tracking-wider text-cyan-400 font-mono font-extrabold leading-tight">Focus Node</div>
                    <h3 className="text-base font-bold text-white tracking-tight mt-0.5 font-mono">{selectedSymbol.name}</h3>
                  </div>
                  <span className="text-[9px] font-mono text-slate-400 bg-slate-800 border border-white/5 px-2 py-0.5 rounded">
                    Line {selectedSymbol.lineStart}
                  </span>
                </div>
                <div className="text-xs text-slate-400 font-mono bg-slate-950 border border-white/5 p-2 rounded truncate select-all">
                  <code>{selectedSymbol.signature || `// No signature registered for ${selectedSymbol.name}`}</code>
                </div>
                <div className="text-[10px] text-slate-500 flex items-center gap-1.5 font-mono">
                  <FileText size={12} />
                  <span>Full path: <strong className="text-slate-300 select-all">{selectedSymbol.filePath}</strong></span>
                </div>
              </div>

              {/* Call Graph visual visualization inside of SVG */}
              <div className="bg-slate-950 border border-white/5 p-4 rounded-xl flex flex-col items-center justify-center relative overflow-hidden min-h-60 shadow-[inset_0_1px_5px_rgba(0,0,0,0.5)]">
                <div className="absolute top-1 left-2 text-[8px] font-mono text-slate-500 uppercase tracking-widest">Call graph map flow</div>
                
                {/* SVG Visual representation */}
                <div className="w-full flex flex-col md:flex-row items-center justify-between gap-4 max-w-lg mt-2 relative z-10 font-mono">
                  
                  {/* Left block (Callers) */}
                  <div className="flex-1 w-full flex flex-col gap-1.5">
                    <div className="text-[9px] text-center text-indigo-400 font-bold uppercase mb-1 flex items-center justify-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-indigo-505" />
                      <span>Incoming Callers ({callers.length})</span>
                    </div>
                    {callers.length === 0 ? (
                      <div className="p-2 border border-dashed border-white/5 text-[9px] text-slate-600 rounded-lg text-center italic">
                        External entry / Uncalled
                      </div>
                    ) : (
                      callers.slice(0, 3).map((e, idx) => {
                        const fromSym = symbols.find(ys => ys.id === e.source);
                        return (
                          <button
                            key={e.id}
                            onClick={() => setSelectedSymbolId(e.source)}
                            className="p-1.5 bg-indigo-950/20 hover:bg-indigo-950/40 border border-indigo-500/10 text-indigo-300 rounded-lg text-left truncate text-[10px] flex items-center justify-between transition-colors"
                          >
                            <span className="font-bold truncate">{fromSym ? fromSym.name : 'Unknown source'}</span>
                            <span className="text-[8px] text-indigo-500 font-extrabold ml-1 shrink-0">Line {e.line}</span>
                          </button>
                        );
                      })
                    )}
                    {callers.length > 3 && (
                      <div className="text-[8px] text-slate-500 text-center italic">+ {callers.length - 3} more callers</div>
                    )}
                  </div>

                  {/* Connecting Flow arrows */}
                  <div className="flex md:flex-col items-center justify-center shrink-0 py-2">
                    <div className="w-4 h-px md:w-px md:h-8 bg-slate-800" />
                    <div className="w-6 h-6 rounded-full bg-[#0B0E14] border border-cyan-500/20 flex items-center justify-center animate-pulse">
                      <ArrowRight size={11} className="text-cyan-400 transform md:rotate-0 rotate-90" />
                    </div>
                    <div className="w-4 h-px md:w-px md:h-8 bg-slate-800" />
                  </div>

                  {/* Middle node (Focus) */}
                  <div className="p-2.5 bg-cyan-550/10 border-2 border-cyan-500 text-cyan-400 w-full md:w-36 rounded-xl font-bold text-center truncate text-[11px] shadow-[0_0_12px_rgba(6,182,212,0.15)] flex flex-col justify-center items-center">
                    <span className="truncate">{selectedSymbol.name}</span>
                    <span className="text-[7px] text-cyan-500 uppercase leading-none font-bold mt-1 tracking-wider">Focus Target</span>
                  </div>

                  {/* Connecting Flow arrows */}
                  <div className="flex md:flex-col items-center justify-center shrink-0 py-2">
                    <div className="w-4 h-px md:w-px md:h-8 bg-slate-800" />
                    <div className="w-6 h-6 rounded-full bg-[#0B0E14] border border-cyan-500/20 flex items-center justify-center animate-pulse">
                      <ArrowRight size={11} className="text-cyan-400 transform md:rotate-0 rotate-90" />
                    </div>
                    <div className="w-4 h-px md:w-px md:h-8 bg-slate-800" />
                  </div>

                  {/* Right block (Callees) */}
                  <div className="flex-1 w-full flex flex-col gap-1.5">
                    <div className="text-[9px] text-center text-teal-400 font-bold uppercase mb-1 flex items-center justify-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-teal-505" />
                      <span>Outgoing Callees ({callees.length})</span>
                    </div>
                    {callees.length === 0 ? (
                      <div className="p-2 border border-dashed border-white/5 text-[9px] text-slate-600 rounded-lg text-center italic">
                        Leaf Node / No other calls
                      </div>
                    ) : (
                      callees.slice(0, 3).map((e) => {
                        const targetSym = symbols.find(ys => ys.id === e.target);
                        return (
                          <button
                            key={e.id}
                            disabled={!e.target}
                            onClick={() => { if (e.target) setSelectedSymbolId(e.target); }}
                            className="p-1.5 bg-teal-950/20 hover:bg-teal-950/40 border border-teal-500/10 text-teal-300 rounded-lg text-left truncate text-[10px] flex items-center justify-between transition-colors disabled:cursor-default"
                          >
                            <span className="font-bold truncate">{targetSym ? targetSym.name : e.targetRaw}</span>
                            <span className="text-[8px] text-teal-500 font-extrabold ml-1 shrink-0">Line {e.line}</span>
                          </button>
                        );
                      })
                    )}
                    {callees.length > 3 && (
                      <div className="text-[8px] text-slate-500 text-center italic">+ {callees.length - 3} more callees</div>
                    )}
                  </div>

                </div>

                {/* Cyber grid background layer inside SVG panel */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(6,182,212,0.02),rgba(255,255,255,0))]" />
              </div>

              {/* Multi-Hop evidence trace path log */}
              <div className="bg-[#0A0D13] border border-white/5 p-4 rounded-xl space-y-3 font-mono">
                <div className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5 border-b border-white/5 pb-2">
                  <Info size={13} className="text-cyan-400 shrink-0" />
                  <span>Call Graph Investigation Log</span>
                </div>

                <div className="space-y-2.5 text-xs text-slate-400">
                  <p className="leading-relaxed">
                    Analyzing active call graph for <strong className="text-cyan-400 font-semibold">{selectedSymbol.name}</strong> inside repository <strong className="text-slate-300">{repoName}</strong>.
                  </p>
                  
                  {callers.length > 0 ? (
                    <div className="space-y-1.5">
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-extrabold">Detected Incoming Paths:</div>
                      {callers.map((c, i) => {
                        const fromSym = symbols.find(s => s.id === c.source);
                        return (
                          <div key={c.id} className="text-[11px] leading-relaxed flex items-start gap-1">
                            <span className="text-indigo-400 shrink-0">Path {i+1}:</span>
                            <span>
                              Ref <strong className="text-white">"{fromSym ? fromSym.name : 'Unknown'}"</strong> inside <code>{c.filePath}</code> at line {c.line} references this target.
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-slate-500 italic">
                      This function is an independent top-level entry point or daemon trigger mechanism inside the current call graph analysis.
                    </p>
                  )}

                  {callees.length > 0 && (
                    <div className="space-y-1.5 mt-2">
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-extrabold">Directed Outgoing Dependencies:</div>
                      {callees.map((c, i) => {
                        const toSym = symbols.find(s => s.id === c.target);
                        return (
                          <div key={c.id} className="text-[11px] leading-relaxed flex items-start gap-1">
                            <span className="text-teal-400 shrink-0">Link {i+1}:</span>
                            <span>
                              This node targets call action <strong className="text-white">"{toSym ? toSym.name : c.targetRaw}"</strong> at line {c.line} inside <code>{c.filePath}</code>.
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
