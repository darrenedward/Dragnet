"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Check, Copy, Eye, EyeOff, Key, RefreshCw, X } from "lucide-react";

type Mode = "reveal" | "manage";

interface Props {
  repoId: string | null;
  mode: Mode;
  initialApiKey?: string;
  initialPrefix?: string | null;
  onClose?: () => void;
  repoName?: string;
  onRefresh?: () => void;
}

interface ExistingKey {
  id: string;
  repoId: string | null;
  name: string;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path (non-secure context, older browser)
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function ApiKeyManager({
  repoId,
  mode,
  initialApiKey = "",
  initialPrefix = null,
  onClose,
  repoName,
  onRefresh,
}: Props) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [prefix, setPrefix] = useState(initialPrefix);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRegenerated, setHasRegenerated] = useState(mode === "reveal");

  const handleCopy = async () => {
    const ok = await copyToClipboard(apiKey);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError("Copy failed — select the key text manually and copy.");
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const existingRes = await fetch("/api/keys");
      if (!existingRes.ok) {
        throw new Error(`Failed to fetch keys (${existingRes.status})`);
      }
      const existingKeys: ExistingKey[] = await existingRes.json();
      // Global keys (repoId null) vs repo-scoped — regenerate the matching set.
      const keysToRevoke =
        repoId === null
          ? existingKeys.filter((k) => !k.repoId)
          : existingKeys.filter((k) => k.repoId === repoId);
      await Promise.all(
        keysToRevoke.map((k) => fetch(`/api/keys/${k.id}`, { method: "DELETE" })),
      );

      // Reuse the prior key's label if present; fall back to a sensible name.
      const keyName =
        keysToRevoke[0]?.name ??
        (repoId === null
          ? "Global"
          : repoName
            ? `project:${repoName}`
            : `project:${repoId}`);

      const body =
        repoId === null ? { name: keyName } : { name: keyName, repoId };
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to regenerate (${res.status})`);
      }
      setApiKey(data.key);
      setPrefix(data.prefix);
      setHasRegenerated(true);
      setCopied(false);
      onRefresh?.();
    } catch (err: any) {
      setError(err?.message || "Failed to regenerate key");
    } finally {
      setRegenerating(false);
    }
  };

  if (mode === "reveal") {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="p-5 bg-[#0F1219] border border-white/15 w-full max-w-md rounded-xl overflow-hidden shadow-2xl"
      >
        <div className="px-0 py-0 mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-amber-500/10 text-amber-400 rounded-lg">
              <Key size={16} />
            </div>
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Project Created
            </span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all cursor-pointer"
              title="Close"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="space-y-4">
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <p className="text-xs text-amber-300 font-mono font-bold">
                Your API Key — save it now
              </p>
            </div>

            <div className="bg-black/60 rounded-lg p-3 text-xs font-mono text-amber-200 break-all select-all leading-relaxed flex items-center justify-between gap-2">
              <span className="min-w-0">
                {showKey ? apiKey : apiKey.replace(/.(?=.{4})/g, "*")}
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
                  onClick={handleCopy}
                  className="p-1.5 hover:bg-amber-500/10 rounded-lg text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  title="Copy to clipboard"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 font-mono">
                Prefix:{" "}
                <code className="text-slate-300">{prefix}</code>
              </span>
            </div>

            <p className="text-[9px] text-amber-400/70 font-mono leading-snug">
              You won&apos;t see this key again. Set it as <code className="text-amber-300">DRAGNET_API_KEY</code> in your client environment.
            </p>
          </div>

          {error && (
            <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2.5">
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="flex-1 bg-amber-600/20 hover:bg-amber-600/30 disabled:opacity-50 border border-amber-500/30 text-amber-300 py-2.5 rounded font-bold transition-all flex items-center justify-center gap-2 cursor-pointer text-xs"
            >
              {regenerating ? (
                <>
                  <RefreshCw size={13} className="animate-spin" />
                  <span>Regenerating...</span>
                </>
              ) : (
                <>
                  <RefreshCw size={13} />
                  <span>Regenerate</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-black py-2.5 rounded font-bold transition-all cursor-pointer text-center text-xs"
            >
              Done
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // Manage mode: show prefix + Regenerate button, then reveal UI after regenerate
  if (mode === "manage") {
    // After regeneration, show the same reveal UI
    if (hasRegenerated && apiKey) {
      return (
        <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-bold">New API key — save it now</span>
            <button
              onClick={handleCopy}
              className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
              aria-label="Copy API key"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all">{apiKey}</code>
          {error && (
            <div className="text-[10px] text-rose-400 flex items-center gap-1 mt-1">
              <AlertCircle size={10} /> {error}
            </div>
          )}
        </div>
      );
    }

    // Default state: show prefix + Regenerate button
    return (
      <div className="flex items-center justify-between bg-slate-900/40 border border-white/10 rounded-lg p-3">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-amber-400" />
          <span className="text-xs text-slate-300">API Key</span>
          {prefix && (
            <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded">
              {prefix}
            </code>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRegenerate}
            disabled={regenerating}
            className="flex items-center gap-1 px-2 py-1 bg-amber-600/20 border border-amber-500/30 text-amber-300 hover:bg-amber-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
          >
            <RefreshCw size={11} className={regenerating ? "animate-spin" : ""} />
            <span>{regenerating ? "Regenerating..." : "Regenerate"}</span>
          </button>
        </div>
      </div>
    );
  }

  return null;
}
