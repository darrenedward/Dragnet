"use client";

import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { fetchJson } from "../../../lib/http";

/**
 * One-shot modal that mints a per-repo API key for the current user
 * (a UserRepo-scoped key for this project). The key is shown exactly once — copy it before
 * closing, like every other API-key reveal flow in the dashboard.
 *
 * Extracted from `MyReposView` (#69 PR 3) so the same modal can be
 * triggered from the sidebar's "Your projects" and "Shared with you"
 * sections.
 */
export default function RepoKeyModal({
  repoId,
  repoName,
  onClose,
}: {
  repoId: string;
  repoName: string;
  onClose: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{ key: string; prefix: string; url: string } | null>(null);
  const [copied, setCopied] = useState<"key" | "env" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetchJson("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `key-${repoName}-${Date.now()}`, repoId }),
      });
      const data = (await res.json().catch(() => ({}))) as { key?: string; prefix?: string; error?: string };
      if (!res.ok) {
        setError(data?.error || "Failed to generate key.");
        return;
      }
      if (data.key && data.prefix) {
        setGenerated({ key: data.key, prefix: data.prefix, url: window.location.origin });
      } else {
        setError("Server returned an unexpected response.");
      }
    } catch (e: any) {
      setError(e?.message || "Failed to generate key.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md bg-[#0F1219] border border-white/10 rounded-xl shadow-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-cyan-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              API Key — {repoName}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/5 rounded text-slate-500 hover:text-white"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {!generated ? (
          <>
            <p className="text-xs text-slate-400">
              Generate a per-repo API key. You can use it with the Dragnet CLI
              and the pre-push hook. <span className="text-amber-400">It will only be shown once.</span>
            </p>
            {error && (
              <div className="p-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-300 font-mono">
                {error}
              </div>
            )}
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="w-full bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <KeyRound size={13} />
              <span>{generating ? "Generating..." : "Generate API Key"}</span>
            </button>
          </>
        ) : (
          <>
            <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="font-bold">New API key — save it now</span>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(generated.key);
                      setCopied("key");
                      setTimeout(() => setCopied(null), 2000);
                    } catch {}
                  }}
                  className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors"
                >
                  {copied === "key" ? "✓ Copied" : "Copy key"}
                </button>
              </div>
              <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all font-mono">
                {generated.key}
              </code>
              <div className="text-[10px] text-amber-400/70 font-mono">
                Prefix: {generated.prefix}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">Dragnet CLI configuration</span>
                <button
                  onClick={async () => {
                    const env = `DRAGNET_URL=${generated.url}\nDRAGNET_REPO_KEY=${generated.key}`;
                    try {
                      await navigator.clipboard.writeText(env);
                      setCopied("env");
                      setTimeout(() => setCopied(null), 2000);
                    } catch {}
                  }}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 font-mono"
                >
                  {copied === "env" ? "✓ Copied" : "Copy variables"}
                </button>
              </div>
              <code className="block bg-black/60 border border-white/5 p-2 rounded text-[10px] break-all whitespace-pre-wrap select-all font-mono text-cyan-300">
                {`DRAGNET_URL=${generated.url}\nDRAGNET_REPO_KEY=${generated.key}`}
              </code>
              <p className="text-[9px] text-slate-600 font-mono">
                Keep this project key private. It is shown once and can be regenerated from project settings.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs px-4 py-2 rounded-lg transition-all cursor-pointer"
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
