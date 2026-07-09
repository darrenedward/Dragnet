"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Save, ShieldAlert, ShieldCheck, Gauge } from "lucide-react";
import { isSameChatModel } from "@/src/lib/skepticSameModel";
import { fetchJson } from "@/src/lib/http";
import { LLM_PRESETS_CHANGED_EVENT } from "./shared";
import { SkepticStatsSummary } from "./SkepticStatsSummary";

/**
 * Skeptic pass panel — toggles the adversarial adjudication feature and
 * configures which findings the fallback model adjudicates.
 *
 * When enabled AND a fallback chat model is configured, each PR scan
 * sends a single batched adversarial prompt to the fallback model after
 * the primary agentic loop completes. The fallback reads the actual file
 * contents at each finding's cited lines and returns verdicts that
 * confirm / downgrade / reject each finding.
 *
 * Gating: the gate fields decide which findings reach the fallback. The
 * defaults are deliberately narrow — blocker-only, Security + Correctness,
 * >= 0.7 confidence, deterministic findings skipped — so the fallback's
 * budget is spent where it matters most. Loosen the gates to adjudicate
 * more findings.
 *
 * Persisted to `.dragnet/skeptic-settings.json` (mode 0600) via
 * PUT /api/llm/skeptic. Defaults to off.
 */

type Severity = "blocker" | "warning" | "suggestion";

const ALL_SEVERITIES: Severity[] = ["blocker", "warning", "suggestion"];
const ALL_CATEGORIES = [
  "Security",
  "Correctness",
  "Performance",
  "Accessibility",
  "Style",
] as const;

interface SkepticSettings {
  enabled: boolean;
  gateSeverity: Severity[];
  gateMinConfidence: number;
  gateCategories: string[];
  skipDeterministic: boolean;
}

const DEFAULTS: SkepticSettings = {
  enabled: false,
  gateSeverity: ["blocker"],
  gateMinConfidence: 0.7,
  gateCategories: ["Security", "Correctness"],
  skipDeterministic: true,
};

export default function SkepticPanel() {
  const [skeptic, setSkeptic] = useState<SkepticSettings>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  // Primary + fallback chat preset refs, fetched alongside skeptic settings
  // so we can detect the same-model self-review trap (issue #72). null on
  // load failure or before first fetch — the same-model guard is a no-op
  // until we have both sides.
  const [primaryChat, setPrimaryChat] = useState<{ endpoint: string; chatModel: string } | null>(null);
  const [fallbackChat, setFallbackChat] = useState<{ endpoint: string; chatModel: string } | null>(null);

  const sameModel = useMemo(
    () => isSameChatModel(primaryChat, fallbackChat),
    [primaryChat, fallbackChat],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchJson("/api/llm/skeptic");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const next = data.skeptic ?? DEFAULTS;
        // Merge against defaults so older files (just {enabled}) load
        // cleanly without losing the new gate fields in the UI state.
        setSkeptic({
          ...DEFAULTS,
          ...next,
          gateSeverity: Array.isArray(next.gateSeverity) ? next.gateSeverity : DEFAULTS.gateSeverity,
          gateCategories: Array.isArray(next.gateCategories)
            ? next.gateCategories
            : DEFAULTS.gateCategories,
        });
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

  // Fetch chat presets to detect the same-model self-review trap. Re-runs
  // whenever the user saves preset changes elsewhere in the LLM config
  // (parent dispatches LLM_PRESETS_CHANGED_EVENT on save) so the warning
  // appears immediately if they reconfigure the fallback to match primary.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetchJson("/api/llm/presets");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const primaryId = data.primaryChatPresetId ?? data.activeChatPresetId ?? "";
        const fallbackId = data.fallbackChatPresetId ?? "";
        const findById = (id: string) =>
          (data.presets ?? []).find((p: { id: string }) => p.id === id) ?? null;
        const primary = findById(primaryId);
        const fallback = findById(fallbackId);
        setPrimaryChat(
          primary ? { endpoint: primary.endpoint ?? "", chatModel: primary.chatModel ?? "" } : null,
        );
        setFallbackChat(
          fallback ? { endpoint: fallback.endpoint ?? "", chatModel: fallback.chatModel ?? "" } : null,
        );
      } catch (err) {
        console.error("Failed loading chat presets for skeptic guard:", err);
      }
    };
    load();
    const onChange = () => {
      if (!cancelled) load();
    };
    if (typeof window !== "undefined") {
      window.addEventListener(LLM_PRESETS_CHANGED_EVENT, onChange);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(LLM_PRESETS_CHANGED_EVENT, onChange);
      }
    };
  }, []);

  // Same-model auto-disable (issue #72): when the fallback matches the
  // primary, the skeptic pass is self-review with no signal. Force the
  // toggle off so a stale `enabled: true` from before the reconfiguration
  // can't silently ship useless scans. The toggle stays interactive=false
  // until the user fixes the underlying preset mismatch in the Chat tab.
  useEffect(() => {
    if (sameModel && skeptic.enabled) {
      setSkeptic((prev) => ({ ...prev, enabled: false }));
      setDirty(true);
    }
  }, [sameModel, skeptic.enabled]);

  const toggle = () => {
    // Same-model guard: never let the user flip the toggle on when the
    // fallback equals the primary. The useEffect above also forces enabled
    // back to false, but blocking here avoids the flicker.
    if (sameModel) return;
    setSkeptic((prev) => ({ ...prev, enabled: !prev.enabled }));
    setDirty(true);
  };

  const toggleSeverity = (sev: Severity) => {
    setSkeptic((prev) => {
      const has = prev.gateSeverity.includes(sev);
      return {
        ...prev,
        gateSeverity: has
          ? prev.gateSeverity.filter((s) => s !== sev)
          : [...prev.gateSeverity, sev],
      };
    });
    setDirty(true);
  };

  const toggleCategory = (cat: string) => {
    setSkeptic((prev) => {
      const has = prev.gateCategories.includes(cat);
      return {
        ...prev,
        gateCategories: has
          ? prev.gateCategories.filter((c) => c !== cat)
          : [...prev.gateCategories, cat],
      };
    });
    setDirty(true);
  };

  const setConfidence = (raw: string) => {
    const num = parseFloat(raw);
    if (Number.isNaN(num)) return;
    const clamped = Math.max(0, Math.min(1, num));
    setSkeptic((prev) => ({ ...prev, gateMinConfidence: clamped }));
    setDirty(true);
  };

  const toggleSkipDeterministic = () => {
    setSkeptic((prev) => ({ ...prev, skipDeterministic: !prev.skipDeterministic }));
    setDirty(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null);
    try {
      // Defense in depth: if the UI somehow let enabled=true through while
      // the fallback matches the primary, strip it before persisting. The
      // scan engine's own guard would skip the pass anyway, but the file
      // shouldn't carry a setting that can never produce signal.
      const payload = sameModel ? { ...skeptic, enabled: false } : skeptic;
      const res = await fetchJson("/api/llm/skeptic", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({
          success: true,
          message: payload.enabled
            ? "Enabled. Next scan adjudicates gated findings via the fallback model."
            : sameModel
              ? "Disabled — fallback chat model matches primary (same-model self-review)."
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
            <label
              className={`flex items-center gap-2.5 group ${sameModel ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              title={
                sameModel
                  ? "Fallback chat model matches primary — same-model self-review produces no signal. Change one of them in the PR Reviewer (Chat) tab to enable."
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={skeptic.enabled}
                onChange={toggle}
                disabled={sameModel}
                className="w-4 h-4 accent-fuchsia-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="text-xs font-mono text-slate-300 group-hover:text-white transition-colors">
                Enable skeptic pass
              </span>
            </label>
            {sameModel && (
              <div className="mt-3 text-[11px] text-amber-300 bg-amber-500/[0.06] border border-amber-500/25 p-3 rounded-lg flex items-start gap-2">
                <ShieldAlert size={13} className="shrink-0 mt-0.5 text-amber-400" />
                <div className="space-y-1.5">
                  <div className="font-mono uppercase tracking-wider text-[10px] text-amber-400">
                    Same-model self-review — pass disabled
                  </div>
                  <div>
                    Your fallback chat model points at the same endpoint + model as the primary
                    (<code className="text-amber-200">{primaryChat?.endpoint || "unknown"}</code>
                    {" / "}
                    <code className="text-amber-200">{primaryChat?.chatModel || "unknown"}</code>).
                    The skeptic pass would be the same model re-grading its own output — same blind
                    spots, no signal. Change one of them in the{" "}
                    <strong>PR Reviewer (Chat)</strong> tab to re-enable.
                  </div>
                </div>
              </div>
            )}
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

      <SkepticStatsSummary fallbackKey={fallbackChat ? `${fallbackChat.endpoint}|${fallbackChat.chatModel}` : null} />

      <div className={`p-4 bg-slate-900/40 rounded-xl border border-white/5 transition-opacity ${skeptic.enabled ? "" : "opacity-60"}`}>
        <h5 className="text-[11px] font-bold font-mono text-slate-300 uppercase tracking-wider mb-1">
          Adjudication gate
        </h5>
        <p className="text-[11px] text-slate-500 leading-relaxed mb-4">
          Findings that fail the gate stay as the primary model produced them — they're never
          sent to the fallback. The defaults (blocker only, ≥ 70% confidence, Security +
          Correctness, deterministic skipped) are tuned to spend the fallback's budget on the
          findings most likely to be worth challenging.
        </p>

        <div className="space-y-4">
          <GateRow label="Severity levels">
            <div className="flex flex-wrap gap-2">
              {ALL_SEVERITIES.map((sev) => {
                const active = skeptic.gateSeverity.includes(sev);
                return (
                  <button
                    key={sev}
                    type="button"
                    onClick={() => toggleSeverity(sev)}
                    disabled={!skeptic.enabled}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors cursor-pointer disabled:cursor-not-allowed ${
                      active
                        ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30"
                        : "bg-slate-800/50 text-slate-400 border-white/5 hover:border-white/10"
                    }`}
                  >
                    {sev}
                  </button>
                );
              })}
            </div>
          </GateRow>

          <GateRow label="Minimum confidence">
            <div className="flex items-center gap-3 flex-1">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={skeptic.gateMinConfidence}
                onChange={(e) => setConfidence(e.target.value)}
                disabled={!skeptic.enabled}
                className="flex-1 accent-fuchsia-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={skeptic.gateMinConfidence}
                onChange={(e) => setConfidence(e.target.value)}
                disabled={!skeptic.enabled}
                className="w-20 px-2 py-1 bg-slate-800/60 text-slate-200 text-[11px] font-mono rounded border border-white/5 focus:outline-none focus:border-fuchsia-500/40 disabled:cursor-not-allowed"
              />
              <span className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
                ({(skeptic.gateMinConfidence * 100).toFixed(0)}%)
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5">
              Findings with no confidence value pass the gate — absence isn't evidence of low confidence.
            </p>
          </GateRow>

          <GateRow label="Categories">
            <div className="flex flex-wrap gap-2">
              {ALL_CATEGORIES.map((cat) => {
                const active = skeptic.gateCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    disabled={!skeptic.enabled}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors cursor-pointer disabled:cursor-not-allowed ${
                      active
                        ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30"
                        : "bg-slate-800/50 text-slate-400 border-white/5 hover:border-white/10"
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5">
              Empty list = nothing clears the gate. Pick at least one category or disable the pass.
            </p>
          </GateRow>

          <GateRow label="Deterministic findings">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={skeptic.skipDeterministic}
                onChange={toggleSkipDeterministic}
                disabled={!skeptic.enabled}
                className="w-4 h-4 accent-fuchsia-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="text-[11px] font-mono text-slate-300">
                Skip tsc / eslint / runner findings
              </span>
            </label>
            <p className="text-[10px] text-slate-500 mt-1.5">
              Deterministic findings come from a tool the user trusts. Skipping them keeps the
              fallback from second-guessing ground truth.
            </p>
          </GateRow>
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

function GateRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-1 sm:gap-4 items-start">
      <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider pt-1">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
