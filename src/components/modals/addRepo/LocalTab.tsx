"use client";

import { useState } from "react";
import { FolderOpen } from "lucide-react";
import DirectoryPickerModal from "../DirectoryPickerModal";
import { inputClass, Field } from "./shared";

interface Props {
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

export default function LocalTab({
  newRepoPath, setNewRepoPath,
  newBaseBranch, setNewBaseBranch,
  newBranchPattern, setNewBranchPattern,
  newTriggerMode, setNewTriggerMode,
  newQuietPeriod, setNewQuietPeriod,
}: Props) {
  const [showDirPicker, setShowDirPicker] = useState(false);

  return (
    <>
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
          * Pro tip: Input <strong className="text-slate-400">./</strong> to read branches from the current Dragnet checkout.
        </p>
      </Field>

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
    </>
  );
}
