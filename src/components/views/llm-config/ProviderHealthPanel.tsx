"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Pause, RefreshCw, RotateCcw, Zap } from "lucide-react";
import { toast } from "../../../lib/toast";

/**
 * Phase 3 provider circuit breaker — per-repo, per-provider health view.
 *
 * Fetches `/api/llm/provider-health` on mount. Renders one row per
 * `{provider_host}:{model}` key, with a state chip:
 *
 *   closed     green   "Healthy" or "N/5 quality failures"
 *   open       amber   "Paused — resumes HH:MM:SS"
 *   half-open   blue   "Probing"
 *
 * Reset actions:
 *   - per-row Reset (one key)
 *   - per-repo Reset (whole file)
 *   - global Reset all (every repo)
 *
 * Auto-refreshes every 10s while visible so an expired cooldown is
 * reflected without a manual reload. Provider health is read-only
 * state — only the scan loop writes to it; this panel only reads +
 * resets.
 */

type CircuitState = "closed" | "open" | "half-open";

interface ProviderHealthRow {
  key: string;
  model: string;
  presetName: string | null;
  state: CircuitState;
  consecutiveQualityFailures: number;
  openedAt: number | null;
  cooldownEndsAt: number | null;
  updatedAt: number;
}

interface RepoHealthSnapshot {
  repoId: string;
  repoName: string;
  repoPath: string;
  providers: ProviderHealthRow[];
}

interface HealthSnapshot {
  threshold: number;
  cooldownMs: number;
  defaultThreshold: number;
  defaultCooldownMs: number;
  repos: RepoHealthSnapshot[];
  serverNowMs: number;
}

export default function ProviderHealthPanel() {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [resettingKey, setResettingKey] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/llm/provider-health", { cache: "no-store" });
      if (!res.ok) return;
      const data: HealthSnapshot = await res.json();
      setSnapshot(data);
    } catch (err) {
      console.error("Failed loading provider health:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    // 10s refresh — cooldown expiry surfaces without a manual reload.
    const id = setInterval(fetchHealth, 10_000);
    // Tick `now` every 1s so the countdown label updates smoothly.
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(id);
      clearInterval(tickId);
    };
  }, [fetchHealth]);

  const resetOne = async (repoPath: string, key: string) => {
    const [host, ...modelParts] = key.split(":");
    const model = modelParts.join(":");
    const endpoint = host ? `https://${host}` : "";
    setResettingKey(key);
    try {
      const res = await fetch("/api/llm/provider-health/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, endpoint, model }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        toast.success("Provider health reset.");
        await fetchHealth();
      } else {
        toast.error(data.error || "Reset failed.");
      }
    } catch (err: any) {
      toast.error("Network error: " + err.message);
    } finally {
      setResettingKey(null);
    }
  };

  const resetRepo = async (repoPath: string) => {
    setResettingKey(`repo:${repoPath}`);
    try {
      const res = await fetch("/api/llm/provider-health/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        toast.success("Repo health cleared.");
        await fetchHealth();
      } else {
        toast.error(data.error || "Reset failed.");
      }
    } catch (err: any) {
      toast.error("Network error: " + err.message);
    } finally {
      setResettingKey(null);
    }
  };

  const resetAll = async () => {
    setResettingKey("all");
    try {
      const res = await fetch("/api/llm/provider-health/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        toast.success("All provider health cleared.");
        await fetchHealth();
      } else {
        toast.error(data.error || "Reset failed.");
      }
    } catch (err: any) {
      toast.error("Network error: " + err.message);
    } finally {
      setResettingKey(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-slate-500 font-mono text-xs">
        Loading provider health...
      </div>
    );
  }

  if (!snapshot || snapshot.repos.length === 0) {
    return (
      <div className="space-y-4">
        <Header threshold={snapshot?.threshold ?? 5} cooldownMs={snapshot?.cooldownMs ?? 15 * 60 * 1000} />
        <div className="p-4 rounded-lg border border-white/5 bg-slate-900/30 text-center">
          <Activity className="mx-auto mb-2 text-slate-500" size={20} />
          <p className="text-xs text-slate-400 font-mono">
            No provider health records yet. Scan a PR — providers that fail
            repeatedly will show up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header threshold={snapshot.threshold} cooldownMs={snapshot.cooldownMs} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={resetAll}
          disabled={resettingKey === "all"}
          className="text-[11px] font-mono uppercase tracking-wider px-3 py-1.5 rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
        >
          {resettingKey === "all" ? <RefreshCw size={11} className="animate-spin" /> : <RotateCcw size={11} />}
          Reset all repos
        </button>
      </div>
      {snapshot.repos.map((repo) => (
        <RepoBlock
          key={repo.repoId}
          repo={repo}
          threshold={snapshot.threshold}
          now={now}
          resettingKey={resettingKey}
          onResetOne={resetOne}
          onResetRepo={resetRepo}
        />
      ))}
    </div>
  );
}

function Header({ threshold, cooldownMs }: { threshold: number; cooldownMs: number }) {
  return (
    <div className="p-3 bg-slate-900/40 rounded-lg border border-white/5">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={14} className="text-emerald-400" />
        <span className="text-xs font-mono uppercase tracking-wider text-slate-300 font-bold">
          Provider Circuit Breaker
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        Providers that fail {threshold} consecutive quality reviews are paused for{" "}
        {Math.round(cooldownMs / 60_000)} minutes. Transport failures and
        interruptions don&apos;t count. After cooldown, a provider becomes
        half-open — one probe scan closes or reopens it.
      </p>
    </div>
  );
}

function RepoBlock({
  repo,
  threshold,
  now,
  resettingKey,
  onResetOne,
  onResetRepo,
}: {
  repo: RepoHealthSnapshot;
  threshold: number;
  now: number;
  resettingKey: string | null;
  onResetOne: (repoPath: string, key: string) => void;
  onResetRepo: (repoPath: string) => void;
}) {
  return (
    <div className="rounded-lg border border-white/5 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-white/[0.02] border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono font-bold text-slate-200 truncate">{repo.repoName}</span>
          <span className="text-[10px] font-mono text-slate-500 truncate">{repo.repoPath}</span>
        </div>
        <button
          type="button"
          onClick={() => onResetRepo(repo.repoPath)}
          disabled={resettingKey === `repo:${repo.repoPath}`}
          className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border border-white/10 text-slate-400 hover:text-rose-300 hover:border-rose-500/30 disabled:opacity-50 cursor-pointer"
        >
          {resettingKey === `repo:${repo.repoPath}` ? "..." : "Reset repo"}
        </button>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] font-mono uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2 font-normal">Provider / Model</th>
            <th className="px-3 py-2 font-normal">State</th>
            <th className="px-3 py-2 font-normal">Quality failures</th>
            <th className="px-3 py-2 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {repo.providers.map((p) => (
            <tr key={p.key} className="border-t border-white/5">
              <td className="px-3 py-2">
                <div className="font-mono text-slate-200">{p.model}</div>
                {p.presetName && (
                  <div className="text-[10px] text-slate-500 font-mono">{p.presetName}</div>
                )}
              </td>
              <td className="px-3 py-2">
                <StateChip row={p} now={now} threshold={threshold} />
              </td>
              <td className="px-3 py-2 font-mono text-slate-400">
                {p.consecutiveQualityFailures}/{threshold}
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => onResetOne(repo.repoPath, p.key)}
                  disabled={resettingKey === p.key}
                  className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded border border-white/10 text-slate-400 hover:text-cyan-300 hover:border-cyan-500/30 disabled:opacity-50 cursor-pointer"
                >
                  {resettingKey === p.key ? "..." : "Reset"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StateChip({ row, now, threshold }: { row: ProviderHealthRow; now: number; threshold: number }) {
  if (row.state === "open") {
    const remaining = row.cooldownEndsAt !== null ? Math.max(0, row.cooldownEndsAt - now) : 0;
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-amber-500/30 text-amber-300 bg-amber-500/10">
        <Pause size={11} />
        Paused — resumes in {formatDuration(remaining)}
      </span>
    );
  }
  if (row.state === "half-open") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-blue-500/30 text-blue-300 bg-blue-500/10">
        <Zap size={11} />
        Probing
      </span>
    );
  }
  // closed
  if (row.consecutiveQualityFailures > 0) {
    const isWarn = row.consecutiveQualityFailures >= threshold - 1;
    const cls = isWarn
      ? "border-orange-500/30 text-orange-300 bg-orange-500/10"
      : "border-yellow-500/30 text-yellow-300 bg-yellow-500/10";
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border ${cls}`}>
        <AlertTriangle size={11} />
        {row.consecutiveQualityFailures}/{threshold} failures
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded border border-emerald-500/30 text-emerald-300 bg-emerald-500/10">
      <CheckCircle2 size={11} />
      Healthy
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    const remMin = mm % 60;
    return `${hh}h${remMin.toString().padStart(2, "0")}m`;
  }
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
