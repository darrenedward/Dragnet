"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Globe, Github, X } from "lucide-react";
import RemoteTab from "./RemoteTab";
import GitHubTab from "./GitHubTab";
import ApiKeyManager from "../../apiKey/ApiKeyManager";

export interface CreatedApiKey {
  repoId: string;
  raw: string;
  prefix: string;
}

interface Props {
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  errorFeedback: string | null;
  createdApiKey: CreatedApiKey | null;
  // shared fields
  newRepoName: string;
  setNewRepoName: (v: string) => void;
  newBaseBranch: string;
  setNewBaseBranch: (v: string) => void;
  newBranchPattern: string;
  setNewBranchPattern: (v: string) => void;
  newTriggerMode: "auto" | "mention";
  setNewTriggerMode: (v: "auto" | "mention") => void;
  newQuietPeriod: number;
  setNewQuietPeriod: (n: number) => void;
  // remote fields
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
  // github fields
  newGithubRepoId: number | null;
  setNewGithubRepoId: (v: number | null) => void;
}

type Tab = "remote" | "github";

export default function AddRepoModal(props: Props) {
  const [tab, setTab] = useState<Tab>("remote");

  const {
    onClose, onSubmit, errorFeedback, createdApiKey,
    newRepoName, setNewRepoName,
    newBaseBranch, setNewBaseBranch,
    newBranchPattern, setNewBranchPattern,
    newTriggerMode, setNewTriggerMode,
    newQuietPeriod, setNewQuietPeriod,
    newRepoMode, setNewRepoMode,
    newCloneUrl, setNewCloneUrl,
    newCloneUrlHttps, setNewCloneUrlHttps,
    newDeployKey, setNewDeployKey,
    newPat, setNewPat,
    newGithubRepoId, setNewGithubRepoId,
  } = props;

  const isSuccessState = !!createdApiKey;

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
            {isSuccessState ? (
              <CheckCircle2 size={16} className="text-emerald-400" />
            ) : tab === "github" ? (
              <Github size={16} className="text-cyan-400 animate-pulse" />
            ) : (
              <Globe size={16} className="text-cyan-400 animate-pulse" />
            )}
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              {isSuccessState
                ? "Project Created"
                : tab === "github"
                  ? "Import from GitHub"
                  : "Register Remote Repository"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab bar (hidden in success state) */}
        {!isSuccessState && (
        <div className="flex border-b border-white/10">
          <button
            type="button"
            onClick={() => setTab("remote")}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              tab === "remote"
                ? "text-cyan-400 border-b-2 border-cyan-400 bg-cyan-400/5"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Remote Repository
          </button>
          <button
            type="button"
            onClick={() => setTab("github")}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
              tab === "github"
                ? "text-cyan-400 border-b-2 border-cyan-400 bg-cyan-400/5"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            <Github size={12} />
            <span>GitHub</span>
          </button>
        </div>
        )}

        {isSuccessState && createdApiKey ? (
          <div className="p-5">
            <ApiKeyManager
              repoId={createdApiKey.repoId}
              mode="reveal"
              initialApiKey={createdApiKey.raw}
              initialPrefix={createdApiKey.prefix}
              onClose={onClose}
            />
          </div>
        ) : (
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
              className="w-full bg-slate-950 border border-white/10 rounded p-2 text-slate-200 outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700"
            />
          </Field>

          {tab === "github" ? (
            <GitHubTab
              onRepoSelect={(repoId, defaultBranch) => {
                setNewGithubRepoId(repoId);
                if (!newBaseBranch) {
                  setNewBaseBranch(defaultBranch);
                }
              }}
              newBaseBranch={newBaseBranch}
              setNewBaseBranch={setNewBaseBranch}
              newBranchPattern={newBranchPattern}
              setNewBranchPattern={setNewBranchPattern}
              newTriggerMode={newTriggerMode}
              setNewTriggerMode={setNewTriggerMode}
              newQuietPeriod={newQuietPeriod}
              setNewQuietPeriod={setNewQuietPeriod}
            />
          ) : (
            <RemoteTab
              newRepoMode={newRepoMode}
              setNewRepoMode={setNewRepoMode}
              newCloneUrl={newCloneUrl}
              setNewCloneUrl={setNewCloneUrl}
              newCloneUrlHttps={newCloneUrlHttps}
              setNewCloneUrlHttps={setNewCloneUrlHttps}
              newDeployKey={newDeployKey}
              setNewDeployKey={setNewDeployKey}
              newPat={newPat}
              setNewPat={setNewPat}
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
              {tab === "github" ? "Import Repository" : "Register Remote"}
            </button>
          </div>
        </form>
        )}
      </motion.div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-500 font-bold mb-1 uppercase text-[9px]">{label}</label>
      {children}
    </div>
  );
}
