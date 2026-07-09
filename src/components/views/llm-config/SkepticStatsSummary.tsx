"use client";

import { useEffect, useState } from "react";
import { Gauge, ShieldAlert, RotateCcw } from "lucide-react";
import { fetchJson } from "@/src/lib/http";
import { LLM_PRESETS_CHANGED_EVENT } from "./shared";

/**
 * Skeptic pass cross-scan stats summary (issue #73).
 *
 * Shows the current fallback model's cumulative reject rate + flags an
 * amber "agreeable skeptic" warning when the rate is <2% over >=50
 * adjudicated findings. Pulls from `/api/llm/skeptic-stats`, which reads
 * the per-repo `skeptic-stats.json` sidecar.
 *
 * Re-fetches whenever the user saves preset changes elsewhere in the
 * LLM config (parent dispatches LLM_PRESETS_CHANGED_EVENT) so the
 * highlighted "current fallback" row follows live configuration.
 *
 * Hidden entirely when no fallback is configured AND no stats exist —
 * nothing meaningful to show until at least one scan has run.
 */

interface SkepticStatsRow {
  key: string;
  model: string;
  presetName: string | null;
  confirmed: number;
  downgraded: number;
  rejected: number;
  adjudicated: number;
  rejectRate: number;
  agreeable: boolean;
  updatedAt: number;
}

interface StatsSnapshot {
  warnRejectRate: number;
  warnMinAdjudicated: number;
  fallback: { endpoint: string; model: string; key: string; presetName: string } | null;
  repos: Array<{
    repoId: string;
    repoName: string;
    repoPath: string;
    providers: SkepticStatsRow[];
  }>;
}

interface Props {
  /**
   * No props — the component fetches everything it needs from
   * `/api/llm/skeptic-stats` (including the current fallback key, which
   * it uses to highlight the matching row). The parent re-renders this
   * component via the `LLM_PRESETS_CHANGED_EVENT` window event when the
   * fallback changes, so no prop wiring is needed.
   */
}

export function SkepticStatsSummary(_: Props) {
  const [snapshot, setSnapshot] = useState<StatsSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchJson("/api/llm/skeptic-stats");
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load stats (${res.status})`);
          return;
        }
        const data = (await res.json()) as StatsSnapshot;
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    const onChange = () => {
      if (!cancelled) load();
    };
    if (typeof window !== "undefined") {
      window.addEventListener(LLM_PRESETS_CHANGED_EVENT, onChange);
      window.addEventListener("dragnet:skeptic-changed", onChange);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(LLM_PRESETS_CHANGED_EVENT, onChange);
        window.removeEventListener("dragnet:skeptic-changed", onChange);
      }
    };
  }, []);

  const handleReset = async (repoPath: string | null, providerKey: string | null) => {
    setResetting(true);
    setError(null);
    try {
      const body = repoPath ? { repoPath, providerKey: providerKey ?? undefined } : {};
      const res = await fetchJson("/api/llm/skeptic-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Reset failed (${res.status})`);
        return;
      }
      // Refetch.
      const refresh = await fetchJson("/api/llm/skeptic-stats");
      if (refresh.ok) {
        const data = (await refresh.json()) as StatsSnapshot;
        setSnapshot(data);
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setResetting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5">
        <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
          <Gauge size={13} className="text-fuchsia-400" />
          Loading skeptic stats...
        </div>
      </div>
    );
  }

  // Nothing to show until at least one scan has run with the pass enabled.
  const hasRepos = (snapshot?.repos?.length ?? 0) > 0;
  if (!snapshot || (!hasRepos && !snapshot.fallback)) {
    return null;
  }

  const fallbackKey = snapshot.fallback?.key ?? null;
  const warnRatePct = (snapshot.warnRejectRate * 100).toFixed(0);
  const fallbackRows: Array<{ row: SkepticStatsRow; repoName: string }> = [];
  for (const repo of snapshot.repos) {
    for (const p of repo.providers) {
      if (fallbackKey && p.key === fallbackKey) {
        fallbackRows.push({ row: p, repoName: repo.repoName });
      }
    }
  }
  const agreeableFallback = fallbackRows.find((r) => r.row.agreeable);

  return (
    <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-fuchsia-500/10 text-fuchsia-400 rounded-lg shrink-0">
          <Gauge size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <h5 className="text-[11px] font-bold font-mono text-slate-300 uppercase tracking-wider mb-1">
            Fallback reject rate
          </h5>
          <p className="text-[11px] text-slate-500 leading-relaxed mb-3">
            Cumulative outcomes across scans. A healthy skeptic rejects some findings — one
            that confirms nearly everything ({warnRatePct}% or less over ≥{snapshot.warnMinAdjudicated} adjudicated)
            is rubber-stamping, not auditing.
          </p>

          {snapshot.fallback && (
            <div className="text-[10px] text-slate-500 mb-2 font-mono">
              Current fallback: <span className="text-slate-300">{snapshot.fallback.presetName}</span>
              {" / "}<code className="text-slate-400">{snapshot.fallback.model}</code>
            </div>
          )}

          {fallbackRows.length === 0 ? (
            <div className="text-[11px] text-slate-500 italic">
              No adjudications recorded for the current fallback yet. Stats appear after the
              next scan that runs with the pass enabled.
            </div>
          ) : (
            <div className="space-y-2">
              {fallbackRows.map(({ row, repoName }) => (
                <FallbackRow
                  key={`${repoName}:${row.key}`}
                  row={row}
                  repoName={repoName}
                  warnRejectRate={snapshot.warnRejectRate}
                  warnMinAdjudicated={snapshot.warnMinAdjudicated}
                  onReset={() => handleReset(
                    snapshot.repos.find((r) => r.repoName === repoName)?.repoPath ?? null,
                    row.key,
                  )}
                  resetting={resetting}
                />
              ))}
            </div>
          )}

          {agreeableFallback && (
            <div className="mt-3 text-[11px] text-amber-300 bg-amber-500/[0.06] border border-amber-500/25 p-3 rounded-lg flex items-start gap-2">
              <ShieldAlert size={13} className="shrink-0 mt-0.5 text-amber-400" />
              <div className="space-y-1.5">
                <div className="font-mono uppercase tracking-wider text-[10px] text-amber-400">
                  Agreeable-skeptic warning
                </div>
                <div>
                  <code className="text-amber-200">{agreeableFallback.row.model}</code> rejected{" "}
                  <strong className="text-amber-200">
                    {agreeableFallback.row.rejected} of {agreeableFallback.row.adjudicated}
                  </strong>{" "}
                  findings it adjudicated. That sub-{warnRatePct}% reject rate suggests the
                  fallback is rubber-stamping the primary&apos;s output rather than auditing
                  it. Consider an adversarial system prompt or a different fallback model.
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-2 text-[10px] text-rose-400 font-mono">{error}</div>
          )}
        </div>
      </div>
    </div>
  );
}

interface FallbackRowProps {
  row: SkepticStatsRow;
  repoName: string;
  warnRejectRate: number;
  warnMinAdjudicated: number;
  onReset: () => void;
  resetting: boolean;
}

function FallbackRow({
  row,
  repoName,
  warnRejectRate,
  warnMinAdjudicated,
  onReset,
  resetting,
}: FallbackRowProps) {
  const pct = (row.rejectRate * 100).toFixed(1);
  const belowMin = row.adjudicated < warnMinAdjudicated;
  const rateColor = row.agreeable
    ? "text-amber-400"
    : row.rejectRate < warnRejectRate
      ? "text-slate-400"
      : "text-emerald-400";
  return (
    <div className="flex items-center gap-3 bg-slate-800/30 border border-white/5 rounded-md px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-mono text-slate-300 flex items-baseline gap-2">
          <span className={rateColor}>{pct}%</span>
          <span className="text-slate-500">
            rejected ({row.rejected}/{row.adjudicated} adjudicated)
          </span>
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          {row.confirmed} confirmed · {row.downgraded} downgraded · repo: {repoName}
          {belowMin && (
            <span className="text-slate-600">
              {" "}· below min sample ({warnMinAdjudicated})
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onReset}
        disabled={resetting}
        title="Reset this provider's skeptic stats"
        className="text-slate-500 hover:text-slate-300 disabled:opacity-50 transition-colors cursor-pointer disabled:cursor-not-allowed"
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}
