"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Database, FolderOpen, X } from "lucide-react";
import DirectoryPickerModal from "./DirectoryPickerModal";

interface Props {
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  errorFeedback: string | null;
  newRepoName: string;
  setNewRepoName: (v: string) => void;
  newRepoPath: string;
  setNewRepoPath: (v: string) => void;
  newBaseBranch: string;
  setNewBaseBranch: (v: string) => void;
  newBranchPattern: string;
  setNewBranchPattern: (v: string) => void;
  newTriggerMode: "auto" | "mention";
  setNewTriggerMode: (v: "auto" | "mention") => void;
  newQuietPeriod: number;
  setNewQuietPeriod: (n: number) => void;
}

export default function AddRepoModal({
  onClose,
  onSubmit,
  errorFeedback,
  newRepoName,
  setNewRepoName,
  newRepoPath,
  setNewRepoPath,
  newBaseBranch,
  setNewBaseBranch,
  newBranchPattern,
  setNewBranchPattern,
  newTriggerMode,
  setNewTriggerMode,
  newQuietPeriod,
  setNewQuietPeriod,
}: Props) {
  const [showDirPicker, setShowDirPicker] = useState(false);

  return (
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
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="p-5 flex flex-col gap-4 text-xs font-mono">
          {errorFeedback && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorFeedback}</span>
            </div>
          )}

          <Field label="Project Name / Alias">
            <input
              required
              type="text"
              placeholder="e.g. fast-api-layer"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Absolute Folder Disk Path">
            <div className="flex gap-2">
              <input
                required
                type="text"
                placeholder="e.g. ./ or /Users/work/server"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setShowDirPicker(true)}
                className="shrink-0 px-3 bg-slate-900 hover:bg-slate-800 border border-white/10 rounded text-cyan-400 transition-all cursor-pointer flex items-center gap-1"
                title="Browse filesystem"
              >
                <FolderOpen size={14} />
                <span className="text-[10px] uppercase tracking-wider">Browse</span>
              </button>
            </div>
            <p className="text-[9px] text-slate-600 mt-1">
              * Pro tip: Input <strong className="text-slate-400">./</strong> to read branches from the current GrepLoop checkout.
            </p>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Base Branch">
              <input
                type="text"
                placeholder="main"
                value={newBaseBranch}
                onChange={(e) => setNewBaseBranch(e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Branch Matcher">
              <input
                type="text"
                placeholder="feature/*"
                value={newBranchPattern}
                onChange={(e) => setNewBranchPattern(e.target.value)}
                className={`${inputClass} text-slate-300`}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Listener Trigger">
              <select
                value={newTriggerMode}
                onChange={(e) => setNewTriggerMode(e.target.value as "auto" | "mention")}
                className={`${inputClass} text-slate-350 cursor-pointer`}
              >
                <option value="auto">auto pipeline</option>
                <option value="mention">@PRBot mention</option>
              </select>
            </Field>
            <Field label="Quiet Cooldown (sec)">
              <input
                type="number"
                min={1}
                max={600}
                value={newQuietPeriod}
                onChange={(e) => setNewQuietPeriod(Number(e.target.value))}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex gap-2.5 mt-2.5 pt-4 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
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

      {showDirPicker && (
        <DirectoryPickerModal
          initialPath={newRepoPath}
          onClose={() => setShowDirPicker(false)}
          onSelect={(p) => {
            setNewRepoPath(p);
            setShowDirPicker(false);
          }}
        />
      )}
    </div>
  );
}

const inputClass =
  "w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">{label}</label>
      {children}
    </div>
  );
}
