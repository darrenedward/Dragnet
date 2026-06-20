"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { ChevronUp, Folder, Home, RefreshCw, X } from "lucide-react";

interface DirEntry {
  name: string;
  path: string;
  isHidden: boolean;
}

interface ListResult {
  success: boolean;
  path: string;
  parent: string | null;
  isHome: boolean;
  entries: DirEntry[];
  error?: string;
}

interface Props {
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

/**
 * Server-backed directory browser. Hits GET /api/fs/list?path=... and lets
 * the user click through to pick a folder. Mounted by AddRepoModal.
 */
export default function DirectoryPickerModal({ initialPath, onClose, onSelect }: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [result, setResult] = useState<ListResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const fetchList = useCallback(async (p: string) => {
    setIsLoading(true);
    try {
      const url = p ? `/api/fs/list?path=${encodeURIComponent(p)}` : "/api/fs/list";
      const res = await fetch(url);
      const data: ListResult = await res.json();
      setResult(data);
      if (data.success) setCurrentPath(data.path);
    } catch (err: any) {
      setResult({
        success: false,
        path: p,
        parent: null,
        isHome: false,
        entries: [],
        error: err?.message || "Network error.",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList(initialPath || "");
  }, [initialPath, fetchList]);

  const visibleEntries = (result?.entries || []).filter((e) => showHidden || !e.isHidden);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-[60] p-4 select-none">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-[#0F1219] border border-white/15 w-full max-w-lg rounded-xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]"
      >
        <div className="px-5 py-4 bg-slate-950/70 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Folder size={16} className="text-cyan-400" />
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Select Folder
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
            aria-label="Close directory picker"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-white/5 bg-slate-950/30 space-y-2">
          <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
            <span>Current Path:</span>
          </div>
          <div className="bg-slate-950 border border-white/10 rounded px-2.5 py-1.5 text-xs text-cyan-400 font-mono truncate" title={currentPath}>
            {currentPath || "(loading...)"}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => result?.parent && fetchList(result.parent)}
              disabled={!result?.parent || isLoading}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              title="Up one level"
            >
              <ChevronUp size={11} />
              <span>Up</span>
            </button>
            <button
              onClick={() => fetchList("")}
              disabled={isLoading || result?.isHome}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              title="Jump to home directory"
            >
              <Home size={11} />
              <span>Home</span>
            </button>
            <button
              onClick={() => fetchList(currentPath)}
              disabled={isLoading}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
              title="Refresh"
            >
              <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
              <span>Refresh</span>
            </button>
            <label className="ml-auto flex items-center gap-1 text-[10px] font-mono text-slate-500 cursor-pointer">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="accent-cyan-500"
              />
              <span className="uppercase">Show hidden</span>
            </label>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {result?.success === false ? (
            <div className="p-6 text-center text-xs text-rose-400 font-mono">
              {result.error || "Cannot read this directory."}
            </div>
          ) : visibleEntries.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 font-mono italic">
              {isLoading ? "Loading..." : "No subdirectories here."}
            </div>
          ) : (
            visibleEntries.map((entry) => (
              <button
                key={entry.path}
                onDoubleClick={() => fetchList(entry.path)}
                onClick={() => setCurrentPath(entry.path)}
                className={`w-full text-left px-4 py-2 text-xs font-mono flex items-center gap-2 transition-colors border-b border-white/5 ${
                  currentPath === entry.path
                    ? "bg-cyan-500/10 text-cyan-400"
                    : entry.isHidden
                    ? "text-slate-600 hover:bg-white/5 hover:text-slate-400"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
                title={`Click to select, double-click to open: ${entry.path}`}
              >
                <Folder size={13} className={currentPath === entry.path ? "text-cyan-400" : "text-slate-500"} />
                <span className="truncate flex-1">{entry.name}</span>
                {entry.isHidden && (
                  <span className="text-[8px] uppercase text-slate-700 shrink-0">hidden</span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="flex gap-2.5 p-4 border-t border-white/10 bg-slate-950/40">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2 rounded font-bold transition-all cursor-pointer text-center text-xs font-mono uppercase"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath}
            className="flex-1 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-black py-2 rounded font-bold transition-all cursor-pointer text-center text-xs font-mono uppercase"
          >
            Select Folder
          </button>
        </div>
      </motion.div>
    </div>
  );
}
