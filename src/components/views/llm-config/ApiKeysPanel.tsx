"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Eye, EyeOff, Key, Plus, Trash2 } from "lucide-react";

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  repoId: string | null;
  user: { id: string; name: string | null; email: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const all = (await res.json()) as ApiKeyView[];
        // Project-scoped keys (repoId !== null) are managed per-project via
        // RepoSettingsModal → API Key section. This panel is for global /
        // standalone keys only (CI, admin automation, multi-project tooling).
        setKeys(all.filter((k) => k.repoId === null));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchKeys().finally(() => setIsLoading(false));
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    setNewKeyValue(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName || "Dragnet API Key" }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewKeyValue(data.key);
        setNewKeyName("");
        await fetchKeys();
      } else {
        setError(data.error);
      }
    } catch {
      setError("Failed to create key.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await fetch(`/api/keys/${id}`, { method: "DELETE" });
      await fetchKeys();
    } catch { /* ignore */ }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 font-mono text-xs">
        Loading API keys...
      </div>
    );
  }

  return (
    <motion.div
      key="api-keys-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 overflow-y-auto space-y-5"
    >
      <div className="p-6 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg">
            <Key size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              API Keys
            </h3>
            <p className="text-xs text-slate-400">
              Global keys for CI, automation, and multi-project tooling. Set <code className="text-cyan-400">Authorization: Bearer</code> on requests. Per-project keys live in each project&apos;s Settings → API Key.
            </p>
          </div>
        </div>

        {keys.length > 0 && (
          <div className="space-y-2 mb-6">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Active Keys</h4>
            <div className="space-y-1.5">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-lg border border-white/5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-slate-300">{k.name}</span>
                      <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 font-mono uppercase">Active</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5">{k.prefix}</div>
                    {k.user && (
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                        Owner: <span className="text-slate-300">{k.user.name || k.user.email}</span>
                      </div>
                    )}
                    {!k.user && (
                      <div className="text-[9px] text-amber-400/80 font-mono mt-0.5">
                        Legacy key — no owner assigned
                      </div>
                    )}
                    <div className="text-[9px] text-slate-600 font-mono">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(k.id)}
                    className="p-2 hover:bg-rose-500/10 rounded-lg text-slate-500 hover:text-rose-400 transition-colors"
                    title="Delete key"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {newKeyValue ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <p className="text-xs text-amber-300 font-mono font-bold">Save this key — it won't be shown again</p>
            </div>
            <div className="bg-black/60 rounded-lg p-3 text-xs font-mono text-amber-200 break-all select-all leading-relaxed flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {showKey ? newKeyValue : newKeyValue!.replace(/.(?=.{4})/g, "*")}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="p-1.5 hover:bg-amber-500/10 rounded-lg text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  title={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  onClick={() => { try { navigator.clipboard.writeText(newKeyValue!); } catch { const ta = document.createElement("textarea"); ta.value = newKeyValue!; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); } setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  className="p-1.5 hover:bg-amber-500/10 rounded-lg text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  title="Copy to clipboard"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div className="bg-black/40 rounded-lg p-2.5 text-[10px] font-mono text-slate-400 leading-relaxed">
              <div className="text-slate-500 mb-1 uppercase tracking-wider text-[9px]">Use in your shell:</div>
              <div className="text-cyan-400">export DRAGNET_API_KEY={showKey ? newKeyValue : "dr_…"}</div>
              <div className="text-cyan-400">export DRAGNET_URL=http://localhost:3300</div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Generate New Key</h4>
            <div className="flex items-center gap-3">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Claude Code"
                className="flex-1 bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                onKeyDown={(e) => { if (e.key === "Enter" && newKeyName.trim()) handleCreate(); }}
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newKeyName.trim()}
                className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
              >
                <Plus size={13} />
                <span>{creating ? "Creating..." : "Generate Key"}</span>
              </button>
            </div>
            {error && <p className="text-xs text-rose-400 font-mono">{error}</p>}
          </div>
        )}
      </div>
    </motion.div>
  );
}
