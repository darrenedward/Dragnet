"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Cpu, RefreshCw, Save, Sparkles } from "lucide-react";
import type { LlmPresetsState } from "../../../lib/types";
import RolePanel from "./RolePanel";
import {
  LLM_PRESETS_CHANGED_EVENT,
  fromViewState,
  newPreset,
  toPutBody,
  type RemoteModel,
  type SaveResult,
  type WorkingPreset,
} from "./shared";

type Tab = "chat" | "embedding";

/**
 * Two-tab LLM config: Chat (PR reviewer) and Embedding (semantic search).
 * Each tab picks one provider preset + one model for that role.
 *
 * Why tabs vs. one long page:
 *  - The same provider catalog may be wanted for both roles, but each role
 *    needs its own model picker. Tabs keep the picker choice unambiguous.
 *  - Reduces visual noise: only one model picker visible at a time.
 *
 * Sidebar sync:
 *  - After a successful save, we dispatch LLM_PRESETS_CHANGED_EVENT on
 *    window. DashboardSidebar listens for it and refetches immediately,
 *    instead of waiting up to 10s for its next poll. This was the root
 *    cause of "the model shown in the bottom left is wrong" — the sidebar
 *    was reading stale state while the user had unsaved edits here.
 */
export default function LlmConfigTabs() {
  const [presets, setPresets] = useState<WorkingPreset[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [activeEmbeddingId, setActiveEmbeddingId] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [dirty, setDirty] = useState(false);

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
        setActiveChatId(mapped.activeChatId);
        setActiveEmbeddingId(mapped.activeEmbeddingId);
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

  const handleSelectActive = (role: Tab, id: string) => {
    if (role === "chat") setActiveChatId(id);
    else setActiveEmbeddingId(id);
    markDirty();
  };

  const handleAddProvider = (role: Tab) => {
    const fresh = newPreset();
    setPresets((prev) => [...prev, fresh]);
    if (role === "chat") setActiveChatId(fresh.id);
    else setActiveEmbeddingId(fresh.id);
    markDirty();
  };

  const handleDeleteActive = (role: Tab) => {
    const id = role === "chat" ? activeChatId : activeEmbeddingId;
    if (!id) return;
    if (activeChatId === id || activeEmbeddingId === id) {
      alert("Clear this preset's active role (pick another provider in the dropdown) before deleting it.");
      return;
    }
    setPresets((prev) => prev.filter((p) => p.id !== id));
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
        body: JSON.stringify(toPutBody(presets, activeChatId, activeEmbeddingId)),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({
          success: true,
          message: "Saved. Changes take effect on the next request — no restart needed.",
        });
        setPresets((prev) =>
          prev.map((p) => ({
            ...p,
            apiKey: "",
            hasApiKey: p.apiKey ? true : p.hasApiKey,
          })),
        );
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

  const activeId = tab === "chat" ? activeChatId : activeEmbeddingId;
  const canDeleteActive = Boolean(activeId) && presets.length > 1;

  return (
    <motion.div
      key="llm-config-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 overflow-y-auto space-y-5"
    >
      <div className="p-6 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden">
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
              Pick a provider and model for each role. The two roles can use different providers — e.g. OpenRouter for chat + Ollama for embeddings. Changes save to <code>.greploop/llm-presets.json</code> and take effect immediately.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 mb-4 border-b border-white/5">
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} accent="cyan" label="PR Reviewer (Chat)" />
          <TabButton active={tab === "embedding"} onClick={() => setTab("embedding")} accent="indigo" label="Semantic Search (Embedding)" />
        </div>

        <RolePanel
          role={tab}
          accent={tab === "chat" ? "cyan" : "indigo"}
          presets={presets}
          activePresetId={activeId}
          canDeleteActive={canDeleteActive}
          onSelectActive={(id) => handleSelectActive(tab, id)}
          onAddProvider={() => handleAddProvider(tab)}
          onDeleteActive={() => handleDeleteActive(tab)}
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
      </div>

      <ExplanatoryCard />
    </motion.div>
  );
}

function TabButton({
  active,
  onClick,
  accent,
  label,
}: {
  active: boolean;
  onClick: () => void;
  accent: "cyan" | "indigo";
  label: string;
}) {
  const accentText = accent === "cyan" ? "text-cyan-400" : "text-indigo-400";
  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";
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
        <span>How the Router Works</span>
      </h4>
      <ul className="space-y-2 text-[11px] text-slate-400 leading-relaxed pl-3 list-disc">
        <li>
          <strong className="text-slate-300">Two roles, two providers:</strong> the PR Reviewer (chat) and Semantic Search (embedding) can use different providers — e.g. OpenRouter for chat + local Ollama for embeddings. Or the same provider for both.
        </li>
        <li>
          <strong className="text-slate-300">Per-tab picker:</strong> each tab shows the active provider dropdown at the top and a single model picker scoped to that role. Add a new provider from either tab; it shows up in both.
        </li>
        <li>
          <strong className="text-slate-300">No restart:</strong> changes take effect on the next request. Keys are stored in <code>.greploop/llm-presets.json</code> with mode 0600.
        </li>
        <li>
          <strong className="text-slate-300">API key masking:</strong> once saved, the key is never sent back to the browser. Leave the field blank on save to keep the stored value.
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
