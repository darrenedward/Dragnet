"use client";

import { motion } from "motion/react";
import { AlertCircle, Globe, X } from "lucide-react";
import RemoteTab from "./RemoteTab";
import type { Repository } from "../../../lib/types";

interface Props {
  repo: Repository;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  errorFeedback: string | null;
  newRepoMode: "ssh" | "pat";
  setNewRepoMode: (v: "ssh" | "pat") => void;
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
  editSkipTier2: boolean;
  setEditSkipTier2: (v: boolean) => void;
  editHostedMode: boolean;
  setEditHostedMode: (v: boolean) => void;
}

export default function EditRepoModal(props: Props) {
  const {
    repo,
    onClose, onSubmit, errorFeedback,
    newRepoMode, setNewRepoMode,
    webhookEnabled, onWebhookEnabledChange,
    ...rest
  } = props;

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
            <Globe size={16} className="text-cyan-400 animate-pulse" />
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

        <form onSubmit={onSubmit} className="p-5 flex flex-col gap-4 text-xs font-mono">
          {errorFeedback && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
              <AlertCircle size={14} className="shrink-0" />
              <span>{errorFeedback}</span>
            </div>
          )}

          <RemoteTab
            {...rest}
            newRepoMode={newRepoMode}
            setNewRepoMode={setNewRepoMode}
            webhookEnabled={webhookEnabled}
            onWebhookEnabledChange={onWebhookEnabledChange}
            lastWebhookEventAt={repo.lastWebhookEventAt ?? null}
          />

          <div className="flex flex-col gap-2 p-3 bg-slate-900/40 border border-white/10 rounded">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={props.editSkipTier2}
                onChange={(e) => props.setEditSkipTier2(e.target.checked)}
                className="w-3.5 h-3.5 accent-cyan-500 rounded"
              />
              <span className="text-slate-300 text-xs font-mono">
                Skip Tier 2 (containerized build/test)
              </span>
            </label>
            <p className="text-[10px] text-slate-500 ml-5 leading-snug">
              When enabled, the containerized build and test pipeline is skipped for this repo.
              Typecheck/lint (Tier 1) and LLM review (Tier 3) still run normally.
            </p>
          </div>

          <div className="flex flex-col gap-2 p-3 bg-slate-900/40 border border-white/10 rounded">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={props.editHostedMode}
                onChange={(e) => props.setEditHostedMode(e.target.checked)}
                className="w-3.5 h-3.5 accent-cyan-500 rounded"
              />
              <span className="text-slate-300 text-xs font-mono">
                Hosted Mode
              </span>
            </label>
            <p className="text-[10px] text-slate-500 ml-5 leading-snug">
              When enabled, external repos can trigger scans via the hosted scan API
              with scan tokens. The scan endpoint accepts POST /api/hosted-scan/scan
              with an <code className="text-cyan-400">hs_</code> token.
            </p>
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
              Save Changes
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
