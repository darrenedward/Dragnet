"use client";

import { useEffect, useState } from "react";
import {
  LOG_VERBOSITY_CHANGED_EVENT,
  type LogVerbosity,
} from "@/src/lib/logVerbosity";

const OPTIONS: Array<{ value: LogVerbosity; label: string; help: string }> = [
  {
    value: "user",
    label: "User",
    help: "Default. Scan progress and outcomes; hides poll spam and tool noise.",
  },
  {
    value: "warn",
    label: "Warn",
    help: "Warnings and errors only (quality failures, finalizer issues).",
  },
  {
    value: "error",
    label: "Error",
    help: "Attention-needed failures only.",
  },
  {
    value: "debug",
    label: "Debug",
    help: "Full diagnostic detail: PR-list polls, tool_call chatter, and more.",
  },
];

/**
 * Settings control for server console + in-app ReviewLog minimum level.
 * Persists to `.dragnet/log-verbosity.json` via PUT /api/llm/log-verbosity.
 */
export default function LogVerbosityPanel() {
  const [level, setLevel] = useState<LogVerbosity>("user");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/log-verbosity");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const next = data.settings?.level;
        if (next === "user" || next === "warn" || next === "error" || next === "debug") {
          setLevel(next);
        }
      } catch {
        if (!cancelled) setMessage("Unable to load log verbosity settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (next: LogVerbosity) => {
    const prev = level;
    setLevel(next);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/llm/log-verbosity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Save failed.");
      setMessage(data.message || "Saved.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(LOG_VERBOSITY_CHANGED_EVENT));
      }
    } catch (err: unknown) {
      setLevel(prev);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-20 text-slate-500 font-mono text-xs">
        Loading log verbosity...
      </div>
    );
  }

  return (
    <section className="border border-white/10 rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold text-white">Log verbosity</h3>
        <p className="text-[11px] text-slate-500 mt-1">
          Minimum level for server console logs and the in-app scan log. Default User keeps Dokploy
          readable; switch to Debug when diagnosing polls or tool noise.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {OPTIONS.map((opt) => {
          const active = level === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={saving}
              onClick={() => void save(opt.value)}
              className={`text-left rounded-lg border px-3 py-2 transition-colors cursor-pointer disabled:opacity-50 ${
                active
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-white/10 bg-slate-950/40 text-slate-300 hover:border-white/20"
              }`}
              aria-pressed={active}
            >
              <span className="text-xs font-mono font-bold uppercase tracking-wider">
                {opt.label}
                {opt.value === "user" ? " (default)" : ""}
              </span>
              <span className="block text-[10px] text-slate-500 mt-1 leading-snug">{opt.help}</span>
            </button>
          );
        })}
      </div>
      {message && <p className="text-[11px] text-slate-400 font-mono">{message}</p>}
    </section>
  );
}
