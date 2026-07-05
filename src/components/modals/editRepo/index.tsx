"use client";

import { motion } from "motion/react";
import { AlertCircle, Database, Globe, X } from "lucide-react";
import LocalTab from "./LocalTab";
import RemoteTab from "./RemoteTab";
import type { Repository } from "../../../lib/types";

interface Props {
  repo: Repository;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  errorFeedback: string | null;
  newRepoMode: "local" | "ssh" | "pat";
  setNewRepoMode: (v: "local" | "ssh" | "pat") => void;
  newRepoPath: string;
  setNewRepoPath: (v: string) => void;
  newCloneUrl: string;
  setNewCloneUrl: (v: string) => void;
  newCloneUrlHttps: string;
  setNewCloneUrlHttps: (v: string) => void;
  newDeployKey: string;
  setNewDeployKey: (v: string) => void;
  newPat: string;
  setNewPat: (v: string) => void;
  webhookEnabled: boolean;
  onWebhookEnabledChange: (v: boolean) => void;
}

export default function EditRepoModal(props: Props) {
  const {
    repo,
    onClose, onSubmit, errorFeedback,
    newRepoMode, setNewRepoMode,
    webhookEnabled, onWebhookEnabledChange,
    ...rest
  } = props;

  const tab: "local" | "remote" = newRepoMode === "local" ? "local" : "remote";

  const handleTabSwitch = (next: "local" | "remote") => {
    if (next === "local") setNewRepoMode("local");
    else if (newRepoMode === "local") setNewRepoMode("ssh");
  };

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
            {tab === "local" ? (
              <Database size={16} className="text-cyan-400 animate-pulse" />
            ) : (
              <Globe size={16} className="text-cyan-400 animate-pulse" />
            )}
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Edit {repo.name}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-white/10">
          <button
            type="button"
            onClick={() => handleTabSwitch("local")}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              tab === "local"
                ? "text-cyan-400 border-b-2 border-cyan-400 bg-cyan-400/5"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Local Directory
          </button>
          <button
            type="button"
            onClick={() => handleTabSwitch("remote")}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              tab === "remote"
                ? "text-cyan-400 border-b-2 border-cyan-400 bg-cyan-400/5"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Remote Repository
          </button>
        </div>

        <form onSubmit={onSubmit} className="p-5 flex flex-col gap-4 text-xs font-mono">
          {errorFeedback && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorFeedback}</span>
            </div>
          )}

          {tab === "local" ? (
            <LocalTab {...rest} />
          ) : (
            <RemoteTab
              {...rest}
              newRepoMode={newRepoMode === "local" ? "ssh" : newRepoMode}
              setNewRepoMode={(v) => setNewRepoMode(v)}
              webhookEnabled={webhookEnabled}
              onWebhookEnabledChange={onWebhookEnabledChange}
              lastWebhookEventAt={repo.lastWebhookEventAt ?? null}
            />
          )}

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
              Save Changes
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
