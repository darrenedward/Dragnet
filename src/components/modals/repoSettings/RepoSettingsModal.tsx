"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  Database,
  FileCode2,
  Globe,
  Hash,
  Key,
  Layers,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import type { Repository } from "../../../lib/types";
import ScanTokensSection from "./ScanTokensSection";

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
  const [resetDone, setResetDone] = useState(false);
  const [deletingWebhook, setDeletingWebhook] = useState(false);
  const [deletedWebhook, setDeletedWebhook] = useState(false);
  const [settingUpWebhook, setSettingUpWebhook] = useState(false);
  const [setupWebhookSuccess, setSetupWebhookSuccess] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [apiKeyPrefix, setApiKeyPrefix] = useState<string | null>(null);
  const [regeneratingKey, setRegeneratingKey] = useState(false);
  const [regeneratedKey, setRegeneratedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [statsRes, repoRes] = await Promise.all([
          fetch(`/api/repos/${repo.id}/stats`),
          fetch(`/api/repos/${repo.id}`),
        ]);
        if (!statsRes.ok) {
          const data = await statsRes.json().catch(() => ({}));
          throw new Error(data?.error || `Failed to fetch stats (${statsRes.status})`);
        }
        setStats(await statsRes.json());
        if (repoRes.ok) {
          const repoData = await repoRes.json();
          setApiKeyPrefix(repoData.apiKeyPrefix || null);
        }
      } catch (err: any) {
        setStatsError(err.message);
      }
    };
    fetchStats();
  }, [repo.id]);

  const handleSetupWebhook = async () => {
    setSettingUpWebhook(true);
    setWebhookError(null);
    try {
      const res = await fetch(`/api/repos/${repo.id}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Failed to setup webhook (${res.status})`);
      }
      setSetupWebhookSuccess(true);
      onRefresh();
    } catch (err: any) {
      setWebhookError(err.message);
    } finally {
      setSettingUpWebhook(false);
    }
  };

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
      setResetDone(true);
      setTimeout(() => {
        setResetDone(false);
        onRefresh();
      }, 3000);
    } catch {
      // error handled upstream
      setIsResetting(false);
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
                <Globe size={14} className={repo.webhookId && !deletedWebhook && !setupWebhookSuccess ? "text-emerald-400" : "text-slate-500"} />
                <span className="text-xs text-slate-300">
                  {repo.webhookId && !deletedWebhook ? "Webhook active" : "Webhook not configured"}
                </span>
                {repo.webhookId && !deletedWebhook && (
                  <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">
                    {repo.webhookId}
                  </code>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!repo.webhookId || deletedWebhook ? (
                  <button
                    onClick={handleSetupWebhook}
                    disabled={settingUpWebhook}
                    className="flex items-center gap-1 px-2 py-1 bg-emerald-600/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
                  >
                    {settingUpWebhook ? (
                      <RefreshCw size={11} className="animate-spin" />
                    ) : (
                      <Plus size={11} />
                    )}
                    <span>{settingUpWebhook ? "Setting up…" : "Setup"}</span>
                  </button>
                ) : null}
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
            {setupWebhookSuccess && (
              <div className="p-2 bg-emerald-950/30 border border-emerald-800/20 text-emerald-400 rounded text-xs">
                Webhook setup complete.
              </div>
            )}
          </div>

          <div className="border-t border-white/10 pt-4 mt-2 space-y-3">
            <div className="flex items-center justify-between bg-slate-900/40 border border-white/10 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <Key size={14} className="text-amber-400" />
                <span className="text-xs text-slate-300">API Key</span>
                {apiKeyPrefix && (
                  <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">
                    {apiKeyPrefix}
                  </code>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setRegeneratingKey(true);
                    setRegeneratedKey(null);
                    try {
                      // Revoke existing keys for this repo first
                      const existingRes = await fetch("/api/keys");
                      if (existingRes.ok) {
                        const existingKeys: { id: string; repoId: string | null }[] = await existingRes.json();
                        const repoKeys = existingKeys.filter((k) => k.repoId === repo.id);
                        await Promise.all(
                          repoKeys.map((k) => fetch(`/api/keys/${k.id}`, { method: "DELETE" })),
                        );
                      }
                      const res = await fetch("/api/keys", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: `project:${repo.name}`, repoId: repo.id }),
                      });
                      const data = await res.json();
                      if (res.ok) {
                        setRegeneratedKey(data.key);
                        setApiKeyPrefix(data.prefix);
                        onRefresh();
                      }
                    } catch { /* ignore */ }
                    setRegeneratingKey(false);
                  }}
                  disabled={regeneratingKey}
                  className="flex items-center gap-1 px-2 py-1 bg-amber-600/20 border border-amber-500/30 text-amber-300 hover:bg-amber-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw size={11} className={regeneratingKey ? "animate-spin" : ""} />
                  <span>{regeneratingKey ? "Regenerating..." : "Regenerate"}</span>
                </button>
              </div>
            </div>
            {regeneratedKey && (
              <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span className="font-bold">New API key — save it now</span>
                  <button
                    onClick={() => {
                      try { navigator.clipboard.writeText(regeneratedKey); } catch { /* ignore */ }
                      setCopiedKey(true);
                      setTimeout(() => setCopiedKey(false), 2000);
                    }}
                    className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    {copiedKey ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all">{regeneratedKey}</code>
              </div>
            )}
          </div>

          {repo.hostedMode && (
            <ScanTokensSection repoId={repo.id} />
          )}

          <div className="border-t border-white/10 pt-4 mt-2">
            {resetDone ? (
              <div className="p-3 bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 rounded-lg text-xs leading-snug space-y-2">
                <div className="flex items-center gap-2">
                  <Check size={16} className="shrink-0" />
                  <strong className="uppercase tracking-wider text-[10px]">Index cleared</strong>
                </div>
                <p className="text-emerald-400/80">
                  All indexed symbols, edges, and embeddings have been deleted.
                  Click <strong>&quot;Index Now&quot;</strong> on the PR view to rebuild the index before running a review.
                </p>
              </div>
            ) : !showConfirm ? (
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
                    You will need to click <strong>&quot;Index Now&quot;</strong> on the PR view to rebuild. Ensure <code className="bg-rose-950/60 px-1 rounded">.env</code>
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
