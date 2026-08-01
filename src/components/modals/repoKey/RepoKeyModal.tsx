"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, X } from "lucide-react";
import { fetchJson } from "../../../lib/http";

/**
 * Per-repo API key modal (sidebar key icon).
 *
 * - Does not mint on every open — loads existing key metadata first.
 * - Full secret is shown only right after mint/regenerate, and kept in
 *   sessionStorage for this browser tab so reopening still shows it.
 * - Always offers Copy for DRAGNET_URL + DRAGNET_REPO_KEY block.
 * - Regenerate is explicit and confirms first (revokes prior keys for repo).
 */

type ExistingKey = {
  id: string;
  name: string;
  prefix: string;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

type Revealed = { key: string; prefix: string; url: string };

function sessionKey(repoId: string): string {
  return `dragnet.repoKey.reveal.${repoId}`;
}

function readSessionReveal(repoId: string): Revealed | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(repoId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Revealed;
    if (parsed?.key && parsed?.prefix && parsed?.url) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function writeSessionReveal(repoId: string, revealed: Revealed): void {
  try {
    sessionStorage.setItem(sessionKey(repoId), JSON.stringify(revealed));
  } catch {
    /* ignore quota / private mode */
  }
}

function clearSessionReveal(repoId: string): void {
  try {
    sessionStorage.removeItem(sessionKey(repoId));
  } catch {
    /* ignore */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function RepoKeyModal({
  repoId,
  repoName,
  onClose,
}: {
  repoId: string;
  repoName: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<ExistingKey[]>([]);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [copied, setCopied] = useState<"key" | "env" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson(`/api/user/keys?repoId=${encodeURIComponent(repoId)}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to load keys (${res.status})`);
      }
      const keys = (await res.json()) as ExistingKey[];
      const active = keys.filter((k) => !k.revoked);
      setExisting(active);

      const session = readSessionReveal(repoId);
      if (session && active.some((k) => k.prefix === session.prefix)) {
        setRevealed(session);
      } else if (session && !active.some((k) => k.prefix === session.prefix)) {
        clearSessionReveal(repoId);
        setRevealed(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load keys.");
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flashCopied = (kind: "key" | "env") => {
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  };

  const envBlock = (keyValue: string) =>
    `DRAGNET_URL=${origin || revealed?.url || ""}\nDRAGNET_REPO_KEY=${keyValue}`;

  const mintOrRegenerate = async (revokeExisting: boolean) => {
    if (revokeExisting) {
      const ok = window.confirm(
        "Regenerate this project key?\n\nThe previous key will stop working immediately. Only do this if it was exposed or lost.",
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      if (revokeExisting && existing.length > 0) {
        await Promise.all(
          existing.map((k) => fetchJson(`/api/keys/${k.id}`, { method: "DELETE" })),
        );
      }
      const res = await fetchJson("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: existing[0]?.name || `key-${repoName}`,
          repoId,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        key?: string;
        prefix?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Failed to generate key.");
      if (!data.key || !data.prefix) throw new Error("Server returned an unexpected response.");
      const next: Revealed = {
        key: data.key,
        prefix: data.prefix,
        url: origin,
      };
      setRevealed(next);
      writeSessionReveal(repoId, next);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate key.");
    } finally {
      setBusy(false);
    }
  };

  const activePrefix = revealed?.prefix || existing[0]?.prefix || null;
  const hasActiveKey = existing.length > 0 || Boolean(revealed);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repo-key-title"
    >
      <div className="w-full max-w-md bg-[#0F1219] border border-white/10 rounded-xl shadow-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-cyan-400" />
            <h3
              id="repo-key-title"
              className="text-sm font-bold text-white uppercase tracking-wider font-mono"
            >
              API Key — {repoName}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-white/5 rounded text-slate-500 hover:text-white"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 font-mono">Loading key status…</p>
        ) : (
          <>
            {error && (
              <div className="p-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-300 font-mono select-text">
                {error}
              </div>
            )}

            {/* Always-visible URL + env template */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-mono">
                  Dragnet CLI / hook env
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const keyPart = revealed?.key || "<your-repo-key>";
                    const ok = await copyText(envBlock(keyPart));
                    if (ok) flashCopied("env");
                    else setError("Copy failed — select the text manually.");
                  }}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 font-mono inline-flex items-center gap-1"
                >
                  <Copy size={11} />
                  {copied === "env" ? "✓ Copied" : "Copy variables"}
                </button>
              </div>
              <code className="block bg-black/60 border border-white/5 p-2 rounded text-[10px] break-all whitespace-pre-wrap select-all font-mono text-cyan-300">
                {envBlock(revealed?.key || (activePrefix ? `${activePrefix}…` : "<generate-key-first>"))}
              </code>
            </div>

            {revealed ? (
              <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5 select-text">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold">Full key (this browser session)</span>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await copyText(revealed.key);
                      if (ok) flashCopied("key");
                    }}
                    className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors inline-flex items-center gap-1 text-[10px]"
                  >
                    {copied === "key" ? (
                      <>
                        <Check size={12} /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={12} /> Copy key
                      </>
                    )}
                  </button>
                </div>
                <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all font-mono">
                  {revealed.key}
                </code>
                <p className="text-[10px] text-amber-400/70 font-mono">
                  Prefix: {revealed.prefix}. Keep private. Prefer Copy variables for .env.local.
                </p>
              </div>
            ) : hasActiveKey ? (
              <div className="p-2.5 bg-slate-900/50 border border-white/10 rounded text-xs text-slate-300 space-y-1.5 select-text">
                <p className="font-mono text-[11px]">
                  Key on file:{" "}
                  <code className="text-cyan-300">{activePrefix}</code>
                  {existing[0]?.lastUsedAt
                    ? ` · last used ${new Date(existing[0].lastUsedAt).toLocaleString()}`
                    : ""}
                </p>
                <p className="text-[10px] text-slate-500 font-mono leading-snug">
                  Full secret is not stored after mint (hashed at rest). Use the key you saved, or
                  Regenerate only if it was lost or exposed.
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-400 font-mono">
                No active key for this project yet. Generate one for CLI and pre-push hooks.
              </p>
            )}

            <div className="flex gap-2">
              {!hasActiveKey ? (
                <button
                  type="button"
                  onClick={() => void mintOrRegenerate(false)}
                  disabled={busy}
                  className="flex-1 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <KeyRound size={13} />
                  <span>{busy ? "Generating…" : "Generate API Key"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void mintOrRegenerate(true)}
                  disabled={busy}
                  className="flex-1 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-500/30 text-amber-200 font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
                  <span>{busy ? "Regenerating…" : "Regenerate key"}</span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs px-4 py-2 rounded-lg transition-all cursor-pointer"
              >
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
