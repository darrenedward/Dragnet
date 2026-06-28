"use client";

import { useState } from "react";
import { Database } from "lucide-react";
import { fetchJson } from "../../../lib/http";

interface Props {
  repoId: string | undefined;
  indexedAt: string | null | undefined;
  onIndexComplete?: () => void;
}

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

export default function IndexNowBanner({ repoId, indexedAt, onIndexComplete }: Props) {
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (indexedAt) return null;

  const handleStart = async () => {
    if (!repoId || isStarting) return;
    setIsStarting(true);
    setError(null);
    try {
      const res = await fetchJson(`/api/repos/${repoId}/index`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.error !== "ALREADY_INDEXING") {
          throw new Error(data?.message || `Index request failed (${res.status})`);
        }
      }

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const poll = await fetchJson(`/api/repos/${repoId}`);
        if (poll.ok) {
          const repo = await poll.json();
          if (repo?.indexedAt) {
            onIndexComplete?.();
            return;
          }
        }
      }
      // Timed out waiting — surface a soft error so the user knows the
      // banner didn't auto-dismiss on its own.
      setError("Indexing is still running in the background — this banner will clear when it finishes.");
    } catch (err: any) {
      setError(err?.message || "Failed to start indexing.");
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="mt-3 p-3 bg-amber-500/[0.05] border border-amber-500/30 rounded-lg text-xs font-mono flex items-start gap-2.5">
      <Database size={14} className="text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 text-amber-200/90">
        <strong className="text-amber-300">Codebase not indexed.</strong>{" "}
        {error ? (
          <span>{error}</span>
        ) : isStarting ? (
          <span>Indexing in progress — this banner clears automatically on completion.</span>
        ) : (
          <span>
            Reviews without an index produce diff-only LLM guesses with no call-graph or semantic
            context. Index the repo first to get real findings.
          </span>
        )}
      </div>
      <button
        onClick={handleStart}
        disabled={isStarting}
        className="bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 px-2.5 py-1 rounded font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-wait"
        title={isStarting ? "Indexing in progress…" : "Run the indexer now"}
      >
        <Database size={11} className={isStarting ? "animate-pulse" : ""} />
        <span>{isStarting ? "Indexing…" : "Index Now"}</span>
      </button>
    </div>
  );
}
