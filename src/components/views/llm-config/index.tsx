"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, ChevronDown, ChevronRight, Cpu, RefreshCw, Save, Sparkles } from "lucide-react";
import type { LlmPresetsState } from "../../../lib/types";
import { toast } from "../../../lib/toast";
import RolePanel from "./RolePanel";
import ApiKeysPanel from "./ApiKeysPanel";
import ReviewLimitsPanel from "./ReviewLimitsPanel";
import AutoRescanPanel from "./AutoRescanPanel";
import ProviderHealthPanel from "./ProviderHealthPanel";
import SkepticPanel from "./SkepticPanel";
import {
  LLM_PRESETS_CHANGED_EVENT,
  EMPTY_SLOT_STATE,
  fromViewState,
  newPreset,
  toPutBody,
  type RemoteModel,
  type SaveResult,
  type SlotId,
  type SlotState,
  type WorkingPreset,
} from "./shared";

type Tab = "chat" | "embedding" | "api" | "limits" | "health" | "skeptic";
type RoleTab = "chat" | "embedding";

/**
 * Two-tab LLM config: Chat (PR reviewer) and Embedding (semantic search).
 * Each tab picks a primary + optional fallback provider preset, and one
 * model for each role on each chosen preset.
 *
 * Multi-provider fallback:
 *  - Primary provider is tried first for every review/embedding call.
 *  - If primary fails, fallback is tried (when configured + distinct).
 *  - If both fail, review returns empty findings + null rating + actionable
 *    systemWarn; embedding trips a circuit breaker and returns [] silently.
 *
 * Sidebar sync:
 *  - After a successful save, we dispatch LLM_PRESETS_CHANGED_EVENT on
 *    window. DashboardSidebar listens for it and refetches immediately,
 *    instead of waiting up to 10s for its next poll.
 */
export default function LlmConfigTabs() {
  const [presets, setPresets] = useState<WorkingPreset[]>([]);
  const [slots, setSlots] = useState<SlotState>(EMPTY_SLOT_STATE);
  const [tab, setTab] = useState<Tab>("chat");
  const [focusSlot, setFocusSlot] = useState<Record<RoleTab, "primary" | "fallback">>({
    chat: "primary",
    embedding: "primary",
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/presets");
        if (!res.ok) return;
        const data: LlmPresetsState = await res.json();
        if (cancelled) return;
        const mapped = fromViewState(data);
        setPresets(mapped.presets);
        setSlots(mapped.slots);
      } catch (err) {
        console.error("Failed loading LLM presets:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const markDirty = () => setDirty(true);

  const updatePreset = (id: string, patch: Partial<WorkingPreset>) => {
    setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    markDirty();
  };

  const setSlot = (slot: SlotId, id: string) => {
    setSlots((prev) => ({ ...prev, [slot]: id }));
    setFocusSlot((prev) => ({
      ...prev,
      [slot.endsWith("Chat") ? "chat" : "embedding"]: slot.startsWith("primary") ? "primary" : "fallback",
    }));
    markDirty();
  };

  const handleAddProvider = (role: RoleTab) => {
    const fresh = newPreset();
    setPresets((prev) => [...prev, fresh]);
    setSlot(role === "chat" ? "primaryChat" : "primaryEmbedding", fresh.id);
    markDirty();
  };

  const handleDeleteActive = (role: RoleTab) => {
    const slotKey = (focusSlot[role] === "primary"
      ? `primary${capitalize(role)}`
      : `fallback${capitalize(role)}`) as SlotId;
    const id = slots[slotKey];
    if (!id) return;

    const inUse = (Object.keys(slots) as SlotId[]).filter(
      (k) => k !== slotKey && slots[k] === id,
    );
    if (inUse.length > 0) {
      toast.warn("This preset is still in use by another slot. Clear that slot first.");
      return;
    }

    setPresets((prev) => prev.filter((p) => p.id !== id));
    setSlots((prev) => ({ ...prev, [slotKey]: "" }));
    setFocusSlot((prev) => ({ ...prev, [role]: "primary" }));
    markDirty();
  };

  const handleFetchModels = async (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    updatePreset(id, { isFetching: true, fetchResult: null });
    try {
      const res = await fetch("/api/llm/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: preset.endpoint, apiKey: preset.apiKey }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const list: RemoteModel[] = data.models || [];
        updatePreset(id, {
          isFetching: false,
          modelsCache: list,
          hasApiKey: preset.apiKey ? true : preset.hasApiKey,
          fetchResult: {
            success: true,
            message: `Connected. ${list.length} models available.`,
          },
        });
      } else {
        updatePreset(id, {
          isFetching: false,
          fetchResult: { success: false, message: data.error || "Failed to reach endpoint." },
        });
      }
    } catch (err: any) {
      updatePreset(id, {
        isFetching: false,
        fetchResult: { success: false, message: "Network or Server Error: " + err.message },
      });
    }
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/llm/presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPutBody(presets, slots)),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({
          success: true,
          message: "Saved. Changes take effect on the next request — no restart needed.",
        });
        setDirty(false);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event(LLM_PRESETS_CHANGED_EVENT));
        }
      } else {
        setSaveResult({ success: false, message: data.error || "Save failed." });
      }
    } catch (err: any) {
      setSaveResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 font-mono text-xs">
        Loading LLM presets...
      </div>
    );
  }

  const isChatTab = tab === "chat";
  const roleTab: RoleTab | null = isChatTab ? "chat" : tab === "embedding" ? "embedding" : null;
  const primaryId = roleTab ? slots[roleTab === "chat" ? "primaryChat" : "primaryEmbedding"] : "";
  const fallbackId = roleTab ? slots[roleTab === "chat" ? "fallbackChat" : "fallbackEmbedding"] : "";
  const focusedId = roleTab ? (focusSlot[roleTab] === "primary" ? primaryId : fallbackId) : "";
  // Block delete when the focused preset is referenced by any slot.
  const slotsUsingFocused = focusedId
    ? (Object.keys(slots) as SlotId[]).filter((k) => slots[k] === focusedId)
    : [];
  const canDeleteActive = Boolean(focusedId) && presets.length > 1 && slotsUsingFocused.length === 1;

  return (
    <motion.div
      key="llm-config-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 min-h-0 space-y-5"
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-[#0F1219] border border-white/10 rounded-xl relative">
        <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg">
            <Cpu size={20} />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              LLM Router
            </h3>
            <p className="text-xs text-slate-400">
              Pick a primary + optional fallback provider for each role. If the primary fails, the fallback is tried automatically. Changes save to the Dragnet database (encrypted keys) and take effect immediately.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowHelp((s) => !s)}
            className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-slate-400 hover:text-cyan-400 border border-white/10 hover:border-cyan-500/30 px-2.5 py-1.5 rounded-lg flex items-center gap-1 cursor-pointer"
            title={showHelp ? "Hide help" : "Show help"}
            aria-expanded={showHelp}
          >
            {showHelp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span>Help</span>
          </button>
        </div>

        {showHelp && (
          <div className="mb-4">
            <ExplanatoryCard />
          </div>
        )}

        <div className="flex items-center gap-1 mb-4 border-b border-white/5">
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} accent="cyan" label="PR Reviewer (Chat)" />
          <TabButton active={tab === "embedding"} onClick={() => setTab("embedding")} accent="indigo" label="Semantic Search (Embedding)" />
          <TabButton active={tab === "api"} onClick={() => setTab("api")} accent="amber" label="API Keys" />
          <TabButton active={tab === "limits"} onClick={() => setTab("limits")} accent="emerald" label="Review Limits" />
          <TabButton active={tab === "health"} onClick={() => setTab("health")} accent="rose" label="Provider Health" />
          <TabButton active={tab === "skeptic"} onClick={() => setTab("skeptic")} accent="fuchsia" label="Skeptic" />
        </div>

        {tab === "api" ? (
          <ApiKeysPanel />
        ) : tab === "limits" ? (
          <div className="space-y-4"><AutoRescanPanel /><ReviewLimitsPanel /></div>
        ) : tab === "health" ? (
          <ProviderHealthPanel />
        ) : tab === "skeptic" ? (
          <SkepticPanel />
        ) : (
          <>
            <RolePanel
              role={roleTab!}
              accent={roleTab === "chat" ? "cyan" : "indigo"}
              presets={presets}
              primaryPresetId={primaryId}
              fallbackPresetId={fallbackId}
              focusSlot={focusSlot[roleTab!]}
              canDeleteActive={canDeleteActive}
              onSelectPrimary={(id) => setSlot(roleTab === "chat" ? "primaryChat" : "primaryEmbedding", id)}
              onSelectFallback={(id) => setSlot(roleTab === "chat" ? "fallbackChat" : "fallbackEmbedding", id)}
              onAddProvider={() => handleAddProvider(roleTab!)}
              onDeleteActive={() => handleDeleteActive(roleTab!)}
              onUpdatePreset={updatePreset}
              onFetchModels={handleFetchModels}
            />

            <div className="flex flex-wrap items-center gap-3 pt-4 mt-4 border-t border-white/5">
              <button
                type="button"
                onClick={handleSaveAll}
                disabled={isSaving || presets.length === 0}
                className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
              >
                {isSaving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
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
                      ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/20"
                      : "text-rose-400 bg-rose-500/10 border-rose-500/20"
                  }`}
                >
                  {saveResult.message}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TabButton({
  active,
  onClick,
  accent,
  label,
}: {
  active: boolean;
  onClick: () => void;
  accent: "cyan" | "indigo" | "amber" | "emerald" | "rose" | "fuchsia";
  label: string;
}) {
  const accentColors: Record<string, { text: string; border: string }> = {
    cyan: { text: "text-cyan-400", border: "border-cyan-500" },
    indigo: { text: "text-indigo-400", border: "border-indigo-500" },
    amber: { text: "text-amber-400", border: "border-amber-500" },
    emerald: { text: "text-emerald-400", border: "border-emerald-500" },
    rose: { text: "text-rose-400", border: "border-rose-500" },
    fuchsia: { text: "text-fuchsia-400", border: "border-fuchsia-500" },
  };
  const { text: accentText, border: accentBorder } = accentColors[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider transition-all border-b-2 -mb-px ${
        active
          ? `${accentText} ${accentBorder}`
          : "text-slate-500 border-transparent hover:text-slate-300"
      }`}
    >
      {label}
    </button>
  );
}

function ExplanatoryCard() {
  return (
    <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5 space-y-3">
      <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
        <Sparkles size={13} className="text-cyan-400" />
        <span>How Multi-Provider Fallback Works</span>
      </h4>
      <ul className="space-y-2 text-[11px] text-slate-400 leading-relaxed pl-3 list-disc">
        <li>
          <strong className="text-slate-300">Primary + fallback per role:</strong> for each of chat and embedding, pick a primary provider (always tried first) and an optional fallback (tried when the primary fails). Leave fallback as <code>(no fallback)</code> for single-provider mode.
        </li>
        <li>
          <strong className="text-slate-300">Honest failure:</strong> if both providers fail, the review returns an empty findings list with a null rating and a clear actionable banner — never templated/hallucinated output. Embeddings trip a session circuit breaker and return empty until you fix the underlying issue.
        </li>
        <li>
          <strong className="text-slate-300">No restart:</strong> changes take effect on the next request. Keys are stored in the Dragnet database, encrypted at rest with <code>DRAGNET_MASTER_KEY</code>.
        </li>
        <li>
          <strong className="text-slate-300">Visible keys:</strong> the actual key is loaded back into the field on every page load. Click the eye to reveal it in plain text — useful for confirming you pasted the right one or for copying into a CLI. The route is session-gated, so this is a usability tradeoff, not a security regression.
        </li>
      </ul>
      <div className="text-[11px] text-amber-500/85 bg-amber-500/[0.02] border border-amber-500/10 p-3 rounded-lg flex items-start gap-2">
        <AlertCircle size={12} className="shrink-0 mt-0.5" />
        <span>
          <strong>Cost notice:</strong> agentic review loops make multiple LLM calls per scan (up to 8 iterations × tool calls). On paid models expect roughly $0.05–$0.50 per PR. Use a cheap model for testing.
        </span>
      </div>
    </div>
  );
}
