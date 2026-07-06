"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Check, Copy, Key, RefreshCw } from "lucide-react";

interface Props {
  repoId: string;
  mode: "reveal";
  initialApiKey: string;
  initialPrefix: string;
  onClose?: () => void;
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
  initialApiKey,
  initialPrefix,
  onClose,
}: Props) {
  const [currentKey, setCurrentKey] = useState(initialApiKey);
  const [currentPrefix, setCurrentPrefix] = useState(initialPrefix);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyToClipboard(currentKey);
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
      const repoKeys = existingKeys.filter((k) => k.repoId === repoId);
      await Promise.all(
        repoKeys.map((k) =>
          fetch(`/api/keys/${k.id}`, { method: "DELETE" }),
        ),
      );

      // Reuse the prior key's label if present; fall back to repoId-derived name.
      const keyName = repoKeys[0]?.name ?? `project:${repoId}`;

      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName, repoId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Failed to regenerate (${res.status})`);
      }
      setCurrentKey(data.key);
      setCurrentPrefix(data.prefix);
      setCopied(false);
    } catch (err: any) {
      setError(err?.message || "Failed to regenerate key");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col gap-4 text-xs font-mono"
    >
      <div className="flex items-center gap-2">
        <Key size={14} className="text-amber-400" />
        <span className="text-[10px] text-slate-300 font-bold uppercase tracking-wider">
          Project API Key
        </span>
        <code className="text-[10px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
          {currentPrefix}
        </code>
      </div>

      <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-bold">Save this key now — you won&apos;t see it again</span>
          <button
            type="button"
            onClick={handleCopy}
            className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
            aria-label="Copy API key"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all">
          {currentKey}
        </code>
        {copied && (
          <div className="text-[10px] text-emerald-400">Copied to clipboard.</div>
        )}
      </div>

      <p className="text-[10px] text-slate-500 leading-snug">
        Use this key as <code className="text-cyan-400">DRAGNET_API_KEY</code> in your client
        environment (CLI, pre-push hook, etc.). The full key is shown only once; the prefix
        is the persistent identifier.
      </p>

      {error && (
        <div className="p-2 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs flex items-center gap-1.5 leading-snug">
          <AlertCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-white/10">
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="flex-1 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-300 py-2.5 rounded font-bold transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          <RefreshCw size={12} className={regenerating ? "animate-spin" : ""} />
          <span>{regenerating ? "Regenerating…" : "Regenerate"}</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 bg-cyan-500 hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(6,182,212,0.3)] text-black py-2.5 rounded font-bold transition-all cursor-pointer"
        >
          Done
        </button>
      </div>
    </motion.div>
  );
}
