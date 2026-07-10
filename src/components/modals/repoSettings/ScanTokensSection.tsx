"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";

interface ScanToken {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revoked: boolean;
}

export default function ScanTokensSection({ repoId }: { repoId: string }) {
  const [tokens, setTokens] = useState<ScanToken[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newTokenRaw, setNewTokenRaw] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTokens = async () => {
    const res = await fetch(`/api/hosted-scan/tokens?repoId=${repoId}`);
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens);
    }
  };

  useEffect(() => { loadTokens(); }, [repoId]);

  const handleCreate = async () => {
    if (!newLabel.trim()) return;
    setCreating(true);
    setError(null);
    setNewTokenRaw(null);
    try {
      const res = await fetch("/api/hosted-scan/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId, label: newLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create token");
        return;
      }
      setNewTokenRaw(data.token.raw);
      setNewLabel("");
      await loadTokens();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    await fetch(`/api/hosted-scan/tokens/${id}`, { method: "DELETE" });
    await loadTokens();
  };

  return (
    <div className="border-t border-white/10 pt-4 mt-2 space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={14} className="text-cyan-400" />
        <span className="text-xs font-bold text-slate-300">Scan Tokens</span>
      </div>

      {error && (
        <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs">{error}</div>
      )}

      {newTokenRaw && (
        <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-bold">New scan token — save it now</span>
            <button
              onClick={() => {
                try { navigator.clipboard.writeText(newTokenRaw); } catch { /* ignore */ }
                setCopiedToken(true);
                setTimeout(() => setCopiedToken(false), 2000);
              }}
              className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors"
            >
              {copiedToken ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all">{newTokenRaw}</code>
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Token label (e.g. ci-token)"
          className="flex-1 bg-slate-950 border border-white/10 rounded p-2 text-slate-200 text-xs outline-hidden focus:border-cyan-500 transition-all placeholder-slate-700"
        />
        <button
          onClick={handleCreate}
          disabled={creating || !newLabel.trim()}
          className="flex items-center gap-1 px-3 py-1.5 bg-cyan-600/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
        >
          {creating ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
          <span>{creating ? "Creating…" : "Create"}</span>
        </button>
      </div>

      {tokens.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {tokens.map((t) => (
            <div key={t.id} className={`flex items-center justify-between bg-slate-900/40 border rounded-lg p-2.5 ${t.revoked ? "border-rose-800/20 opacity-50" : "border-white/10"}`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-slate-300 truncate">{t.label}</span>
                <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded shrink-0">
                  {t.prefix}
                </code>
                {t.revoked && <span className="text-[10px] text-rose-400 font-bold">Revoked</span>}
              </div>
              {!t.revoked && (
                <button
                  onClick={() => handleRevoke(t.id)}
                  className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                  title="Revoke token"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
