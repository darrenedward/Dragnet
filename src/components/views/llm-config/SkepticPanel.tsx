"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Save, ShieldCheck } from "lucide-react";

/**
 * Skeptic pass panel — toggles the adversarial adjudication feature.
 *
 * When enabled AND a fallback chat model is configured, each PR scan
 * sends a single batched adversarial prompt to the fallback model after
 * the primary agentic loop completes. The fallback reads the actual file
 * contents at each finding's cited lines and returns verdicts that
 * confirm / downgrade / reject each finding.
 *
 * Persisted to `.dragnet/skeptic-settings.json` (mode 0600) via
 * PUT /api/llm/skeptic. Defaults to off.
 */
interface SkepticSettings {
  enabled: boolean;
}

const DEFAULTS: SkepticSettings = { enabled: false };

export default function SkepticPanel() {
  const [skeptic, setSkeptic] = useState<SkepticSettings>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/skeptic");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.skeptic) setSkeptic(data.skeptic);
      } catch (err) {
        console.error("Failed loading skeptic settings:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = () => {
    setSkeptic((prev) => ({ ...prev, enabled: !prev.enabled }));
    setDirty(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/llm/skeptic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(skeptic),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({
          success: true,
          message: skeptic.enabled
            ? "Enabled. Next scan adjudicates findings via the fallback model."
            : "Disabled. Next scan behaves as before.",
        });
        setDirty(false);
        window.dispatchEvent(new Event("dragnet:skeptic-changed"));
      } else {
        setSaveResult({ success: false, message: data.error || "Save failed." });
      }
    } catch (e: any) {
      setSaveResult({ success: false, message: "Network or server error: " + e.message });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-slate-500 font-mono text-xs">
        Loading skeptic settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-fuchsia-500/10 text-fuchsia-400 rounded-lg shrink-0">
            <ShieldCheck size={18} />
          </div>
          <div className="flex-1">
            <h4 className="text-xs font-bold font-mono text-fuchsia-300 uppercase tracking-wider mb-1">
              Skeptic pass
            </h4>
            <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
              An adversarial second-opinion layer. When enabled, each PR scan sends a single
              batched prompt to your <strong className="text-slate-300">fallback chat model</strong>{" "}
              with the actual file contents at each finding's cited lines. The fallback returns
              verdicts that:
            </p>
            <ul className="space-y-1.5 text-[11px] text-slate-400 pl-3 list-disc mb-3">
              <li>
                <strong className="text-emerald-400">Confirm</strong> — finding is real, kept as-is.
              </li>
              <li>
                <strong className="text-amber-400">Downgrade</strong> — finding is real but severity is too high; severity is mutated.
              </li>
              <li>
                <strong className="text-rose-400">Reject</strong> — finding is a false positive; filtered from the active list (still visible in the rejected audit list).
              </li>
            </ul>
            <label className="flex items-center gap-2.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={skeptic.enabled}
                onChange={toggle}
                className="w-4 h-4 accent-fuchsia-500 cursor-pointer"
              />
              <span className="text-xs font-mono text-slate-300 group-hover:text-white transition-colors">
                Enable skeptic pass
              </span>
            </label>
            <div className="mt-3 text-[10px] text-amber-500/85 bg-amber-500/[0.02] border border-amber-500/10 p-2.5 rounded-lg flex items-start gap-2">
              <AlertCircle size={11} className="shrink-0 mt-0.5" />
              <span>
                Requires a fallback chat model configured in the <strong>PR Reviewer (Chat)</strong> tab.
                When no fallback is set, the skeptic silently skips each scan (single log line).
                Batched call caps at 30 findings per scan; overflow gets no verdict.
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/5">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="bg-fuchsia-500 hover:bg-fuchsia-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
        >
          {isSaving ? null : <Save size={13} />}
          <span>{isSaving ? "Saving..." : "Save Changes"}</span>
        </button>
        {dirty && !isSaving && (
          <span className="text-[11px] font-mono px-2 py-1 rounded border text-amber-400 bg-amber-500/10 border-amber-500/20 flex items-center gap-1">
            <AlertCircle size={10} /> Unsaved changes
          </span>
        )}
        {saveResult && (
          <span
            className={`text-[11px] font-mono px-2 py-1 rounded border ${
              saveResult.success
                ? "text-fuchsia-400 bg-fuchsia-500/10 border-fuchsia-500/20"
                : "text-rose-400 bg-rose-500/10 border-rose-500/20"
            }`}
          >
            {saveResult.message}
          </span>
        )}
      </div>
    </div>
  );
}
