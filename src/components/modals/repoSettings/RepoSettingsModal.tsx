"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Database,
  FileCode2,
  Globe,
  Hash,
  Layers,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Repository } from "../../../lib/types";

interface RepoStats {
  indexedAt: string | null;
  lastCommitHash: string | null;
  headCommit: string | null;
  isStale: boolean;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  fileCountWithEmbeddings: number;
  embeddingCoveragePct: number;
}

interface Props {
  repo: Repository;
  onClose: () => void;
  onResetIndex: (repoId: string) => Promise<void>;
  onRefresh: () => void;
}

export default function RepoSettingsModal({ repo, onClose, onResetIndex, onRefresh }: Props) {
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [deletingWebhook, setDeletingWebhook] = useState(false);
  const [deletedWebhook, setDeletedWebhook] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`/api/repos/${repo.id}/stats`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `Failed to fetch stats (${res.status})`);
        }
        setStats(await res.json());
      } catch (err: any) {
        setStatsError(err.message);
      }
    };
    fetchStats();
  }, [repo.id]);

  const handleDeleteWebhook = async () => {
    setDeletingWebhook(true);
    setWebhookError(null);
    try {
      const res = await fetch(`/api/repos/${repo.id}/webhook`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Failed to delete webhook (${res.status})`);
      }
      setDeletedWebhook(true);
    } catch (err: any) {
      setWebhookError(err.message);
    } finally {
      setDeletingWebhook(false);
    }
  };

  const handleResetIndex = async () => {
    setIsResetting(true);
    try {
      await onResetIndex(repo.id);
      setShowConfirm(false);
      onRefresh();
    } catch {
      // error handled upstream
    } finally {
      setIsResetting(false);
    }
  };

  const shortHash = (h: string | null) => (h ? h.slice(0, 7) : "—");
  const fmtDate = (d: string | null) => {
    if (!d) return "Never";
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
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
            <BarChart3 size={16} className="text-cyan-400" />
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              {repo.name} — Index Settings
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 text-xs font-mono">
          {statsError && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
              <AlertCircle size={14} className="shrink-0" />
              <span>{statsError}</span>
            </div>
          )}

          {stats && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <StatBox
                  icon={<Database size={14} className="text-cyan-400" />}
                  label="Indexed"
                  value={fmtDate(stats.indexedAt)}
                />
                <StatBox
                  icon={<Hash size={14} className="text-slate-400" />}
                  label="Last Indexed Commit"
                  value={shortHash(stats.lastCommitHash)}
                />
                <StatBox
                  icon={<RefreshCw size={14} className={stats.isStale ? "text-amber-400" : "text-emerald-400"} />}
                  label="Working Tree HEAD"
                  value={
                    <span className={stats.isStale ? "text-amber-400" : "text-emerald-400"}>
                      {shortHash(stats.headCommit)}
                      {stats.isStale && " (stale)"}
                    </span>
                  }
                />
                <StatBox
                  icon={<Layers size={14} className="text-slate-400" />}
                  label="Symbols / Edges"
                  value={`${stats.symbolCount} / ${stats.edgeCount}`}
                />
                <StatBox
                  icon={<FileCode2 size={14} className="text-slate-400" />}
                  label="Indexed Files"
                  value={`${stats.fileCount}`}
                />
                <StatBox
                  icon={<BarChart3 size={14} className={stats.embeddingCoveragePct >= 80 ? "text-emerald-400" : "text-amber-400"} />}
                  label="Embedding Coverage"
                  value={
                    <span className={stats.embeddingCoveragePct >= 80 ? "text-emerald-400" : "text-amber-400"}>
                      {stats.embeddingCoveragePct}% ({stats.fileCountWithEmbeddings}/{stats.fileCount})
                    </span>
                  }
                />
              </div>
            </div>
          )}

          {!stats && !statsError && (
            <div className="text-slate-500 text-center py-6 animate-pulse">Loading stats…</div>
          )}

          <div className="border-t border-white/10 pt-4 mt-2 space-y-3">
            <div className="flex items-center justify-between bg-slate-900/40 border border-white/10 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <Globe size={14} className={repo.webhookId && !deletedWebhook ? "text-emerald-400" : "text-slate-500"} />
                <span className="text-xs text-slate-300">
                  {repo.webhookId && !deletedWebhook ? "Webhook active" : "Webhook not configured"}
                </span>
                {repo.webhookId && !deletedWebhook && (
                  <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">
                    {repo.webhookId}
                  </code>
                )}
              </div>
              {repo.webhookId && !deletedWebhook && (
                <button
                  onClick={handleDeleteWebhook}
                  disabled={deletingWebhook}
                  className="flex items-center gap-1 px-2 py-1 bg-rose-600/20 border border-rose-500/30 text-rose-300 hover:bg-rose-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
                >
                  {deletingWebhook ? (
                    <RefreshCw size={11} className="animate-spin" />
                  ) : (
                    <Trash2 size={11} />
                  )}
                  <span>{deletingWebhook ? "Deleting…" : "Delete"}</span>
                </button>
              )}
            </div>
            {webhookError && (
              <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs">
                {webhookError}
              </div>
            )}
            {deletedWebhook && (
              <div className="p-2 bg-emerald-950/30 border border-emerald-800/20 text-emerald-400 rounded text-xs">
                Webhook deleted. It will no longer receive events.
              </div>
            )}
          </div>

          <div className="border-t border-white/10 pt-4 mt-2">
            {!showConfirm ? (
              <button
                onClick={() => setShowConfirm(true)}
                className="w-full px-3 py-2.5 bg-rose-600/20 border border-rose-500/30 text-rose-300 hover:bg-rose-600/30 hover:text-rose-200 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <AlertTriangle size={14} />
                <span>Reset Index — Wipe all symbols, edges & embeddings</span>
              </button>
            ) : (
              <div className="space-y-2">
                <div className="p-2.5 bg-rose-950/30 border border-rose-500/30 text-rose-300 rounded text-xs leading-snug">
                  <strong className="uppercase tracking-wider text-[10px]">Destructive action</strong>
                  <p className="mt-1 text-rose-400/80">
                    This will delete all indexed symbols, edges, and embeddings for this repo.
                    A full re-index will be triggered. Ensure <code className="bg-rose-950/60 px-1 rounded">.env</code>
                    {" "}files are in <code className="bg-rose-950/60 px-1 rounded">.gitignore</code> before proceeding.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowConfirm(false)}
                    disabled={isResetting}
                    className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2 rounded font-bold transition-all cursor-pointer disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleResetIndex}
                    disabled={isResetting}
                    className="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-2 rounded font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                  >
                    {isResetting ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        <span>Resetting…</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={13} />
                        <span>Confirm Reset</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function StatBox({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="bg-slate-900/60 border border-white/5 rounded-lg p-2.5 space-y-1">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-slate-500 font-bold">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-[11px] font-bold text-white truncate">
        {value}
      </div>
    </div>
  );
}
