"use client";

import { AlertTriangle, Check, Database, RefreshCw, Settings } from "lucide-react";
import type { ConfigHealthReport } from "../lib/types";

interface Props {
  health: ConfigHealthReport | null;
  onOpenDbSettings: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onUseCurrentUrl: () => Promise<void>;
}

export default function SystemSetupBanner({
  health,
  onOpenDbSettings,
  onOpenSettings,
  onRefresh,
  onUseCurrentUrl,
}: Props) {
  if (!health || health.ok || health.items.length === 0) return null;

  const blocking = health.items.filter((item) => item.severity === "blocking");
  const visibleItems = health.items.slice(0, 3);
  const hiddenCount = Math.max(0, health.items.length - visibleItems.length);
  const needsPublicUrl = health.items.some((item) => item.id === "public-url");

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 sm:px-6 py-3 shrink-0">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
        <div className="flex gap-3 min-w-0">
          <div className="w-8 h-8 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <AlertTriangle size={16} className="text-amber-300" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-amber-100 tracking-tight">
                Setup needed
              </h2>
              <span className="text-[10px] font-mono uppercase text-amber-200/80 border border-amber-500/25 rounded px-1.5 py-0.5">
                restart required
              </span>
              {blocking.length > 0 && (
                <span className="text-[10px] font-mono uppercase text-rose-200/90 border border-rose-500/25 rounded px-1.5 py-0.5">
                  {blocking.length} blocking
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-amber-100/80">
              Complete the missing server setup below. These settings are stored by Dragnet; environment variables are only needed for deployment overrides.
            </p>

            <div className="mt-2 grid gap-1.5">
              {visibleItems.map((item) => (
                <div key={item.id} className="text-xs text-slate-300 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                  <span className="font-semibold text-amber-100">{item.label}</span>
                  <span className="hidden sm:inline text-slate-600">/</span>
                  <span className="text-slate-400">{item.feature}</span>
                  <span className="flex flex-wrap gap-1">
                    {item.variables.map((name) => (
                      <code key={name} className="font-mono text-[10px] text-amber-100 bg-black/25 border border-amber-500/20 rounded px-1.5 py-0.5">
                        {name}
                      </code>
                    ))}
                  </span>
                </div>
              ))}
              {hiddenCount > 0 && (
                <div className="text-xs text-amber-100/75">
                  +{hiddenCount} more configuration {hiddenCount === 1 ? "item" : "items"}.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {needsPublicUrl && (
            <button
              onClick={onUseCurrentUrl}
              className="h-8 px-2.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-xs font-semibold text-slate-950 border border-cyan-300/50 flex items-center gap-1.5"
            >
              <Check size={13} />
              <span>Use this address</span>
            </button>
          )}
          <button
            onClick={onOpenDbSettings}
            className="h-8 px-2.5 rounded-md bg-slate-950/70 hover:bg-slate-900 text-xs font-semibold text-slate-200 border border-white/10 flex items-center gap-1.5"
          >
            <Database size={13} />
            <span>Data Source</span>
          </button>
          <button
            onClick={onOpenSettings}
            className="h-8 px-2.5 rounded-md bg-slate-950/70 hover:bg-slate-900 text-xs font-semibold text-slate-200 border border-white/10 flex items-center gap-1.5"
          >
            <Settings size={13} />
            <span>Settings</span>
          </button>
          <button
            onClick={onRefresh}
            className="h-8 w-8 rounded-md bg-slate-950/70 hover:bg-slate-900 text-slate-200 border border-white/10 flex items-center justify-center"
            title="Refresh setup status"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
