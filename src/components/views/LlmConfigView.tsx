"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Cpu, Eye, EyeOff, Plus, RefreshCw, Search, Sparkles, Terminal, Trash2 } from "lucide-react";
import type { LlmPresetView, LlmPresetsState } from "../../lib/types";

interface RemoteModel {
  id: string;
  name?: string;
}

interface FetchResult {
  success: boolean;
  message: string;
  count?: number;
}

interface SaveResult {
  success: boolean;
  message: string;
}

/**
 * Local working copy of a preset. Differs from LlmPresetView by carrying
 * the apiKey as a free-text field (empty string when the user hasn't
 * typed a new key — server preserves the stored one in that case).
 */
interface WorkingPreset {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
  modelsCache: RemoteModel[] | null;
  showApiKey: boolean;
  fetchResult: FetchResult | null;
  isFetching: boolean;
}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

function newPreset(): WorkingPreset {
  return {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    endpoint: DEFAULT_ENDPOINT,
    apiKey: "",
    hasApiKey: false,
    chatModel: "",
    embeddingModel: "",
    modelsCache: null,
    showApiKey: false,
    fetchResult: null,
    isFetching: false,
  };
}

export default function LlmConfigView() {
  const [presets, setPresets] = useState<WorkingPreset[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [activeEmbeddingId, setActiveEmbeddingId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/presets");
        if (!res.ok) return;
        const data: LlmPresetsState = await res.json();
        if (cancelled) return;
        setPresets(
          data.presets.map((p) => ({
            id: p.id,
            name: p.name,
            endpoint: p.endpoint,
            apiKey: "",
            hasApiKey: p.hasApiKey,
            chatModel: p.chatModel,
            embeddingModel: p.embeddingModel,
            modelsCache: null,
            showApiKey: false,
            fetchResult: null,
            isFetching: false,
          })),
        );
        setActiveChatId(data.activeChatPresetId);
        setActiveEmbeddingId(data.activeEmbeddingPresetId);
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

  const updatePreset = (id: string, patch: Partial<WorkingPreset>) => {
    setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleAddPreset = () => {
    setPresets((prev) => [...prev, newPreset()]);
  };

  const handleDeletePreset = (id: string) => {
    if (activeChatId === id || activeEmbeddingId === id) {
      alert("Clear the chat or embedding radio on this preset before deleting it.");
      return;
    }
    setPresets((prev) => prev.filter((p) => p.id !== id));
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
            message: `Connected. Catalog returned ${list.length} models.`,
            count: list.length,
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
      const body = {
        presets: presets.map((p) => ({
          id: p.id,
          name: p.name,
          endpoint: p.endpoint,
          apiKey: p.apiKey,
          chatModel: p.chatModel,
          embeddingModel: p.embeddingModel,
        })),
        activeChatPresetId: activeChatId,
        activeEmbeddingPresetId: activeEmbeddingId,
      };
      const res = await fetch("/api/llm/presets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({ success: true, message: "Presets saved. Changes take effect on the next request — no restart needed." });
        setPresets((prev) =>
          prev.map((p) => ({
            ...p,
            apiKey: "",
            hasApiKey: p.apiKey ? true : p.hasApiKey,
          })),
        );
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
          <div className="p-2 bg-cyan-500/10 text-cyan-405 rounded-lg">
            <Cpu size={20} />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              LLM Provider Presets
            </h3>
            <p className="text-xs text-slate-400">
              Configure multiple providers. Pick one for chat (PR review) and one for embeddings (semantic search) — they can be the same or different. Changes save to <code>.greploop/llm-presets.json</code> and take effect immediately.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {presets.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500 font-mono bg-slate-950/65 rounded-xl border border-dashed border-white/10">
              No presets yet. Click "Add Preset" to configure your first provider.
            </div>
          ) : (
            presets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                isActiveChat={activeChatId === preset.id}
                isActiveEmbedding={activeEmbeddingId === preset.id}
                canActivateChat={Boolean(preset.chatModel)}
                canActivateEmbedding={Boolean(preset.embeddingModel)}
                onUpdate={(patch) => updatePreset(preset.id, patch)}
                onDelete={() => handleDeletePreset(preset.id)}
                onFetchModels={() => handleFetchModels(preset.id)}
                onSetActiveChat={() => setActiveChatId(activeChatId === preset.id ? "" : preset.id)}
                onSetActiveEmbedding={() => setActiveEmbeddingId(activeEmbeddingId === preset.id ? "" : preset.id)}
              />
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-4 mt-4 border-t border-white/5">
          <button
            onClick={handleAddPreset}
            className="bg-slate-900 hover:bg-slate-800 text-slate-300 border border-white/10 font-mono text-xs font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
          >
            <Plus size={13} className="text-cyan-400" />
            <span>Add Preset</span>
          </button>
          <button
            onClick={handleSaveAll}
            disabled={isSaving || presets.length === 0}
            className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
          >
            {isSaving ? <RefreshCw size={13} className="animate-spin" /> : <Cpu size={13} />}
            <span>{isSaving ? "Saving..." : "Save All"}</span>
          </button>
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

function PresetCard({
  preset,
  isActiveChat,
  isActiveEmbedding,
  canActivateChat,
  canActivateEmbedding,
  onUpdate,
  onDelete,
  onFetchModels,
  onSetActiveChat,
  onSetActiveEmbedding,
}: {
  preset: WorkingPreset;
  isActiveChat: boolean;
  isActiveEmbedding: boolean;
  canActivateChat: boolean;
  canActivateEmbedding: boolean;
  onUpdate: (patch: Partial<WorkingPreset>) => void;
  onDelete: () => void;
  onFetchModels: () => void;
  onSetActiveChat: () => void;
  onSetActiveEmbedding: () => void;
}) {
  const isActive = isActiveChat || isActiveEmbedding;
  const borderClass = isActive
    ? "border-cyan-500/40 ring-1 ring-cyan-500/20"
    : "border-white/10";

  return (
    <div className={`bg-slate-950/65 rounded-xl border ${borderClass} p-4 space-y-3 transition-all`}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={preset.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="Preset name (e.g. OpenRouter, Ollama Local)"
          className="flex-1 bg-transparent border-none text-sm text-white font-mono font-bold focus:outline-none placeholder:text-slate-600"
        />
        {isActiveChat && (
          <span className="text-[9px] text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20 font-mono uppercase shrink-0 flex items-center gap-1">
            <CheckCircle2 size={9} /> Chat
          </span>
        )}
        {isActiveEmbedding && (
          <span className="text-[9px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20 font-mono uppercase shrink-0 flex items-center gap-1">
            <CheckCircle2 size={9} /> Embed
          </span>
        )}
        <button
          onClick={onDelete}
          className="text-slate-500 hover:text-rose-400 transition-colors p-1"
          title="Delete preset"
          aria-label="Delete preset"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FieldLabel label="Endpoint URL">
          <input
            type="text"
            value={preset.endpoint}
            onChange={(e) => onUpdate({ endpoint: e.target.value })}
            placeholder={DEFAULT_ENDPOINT}
            className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
          />
        </FieldLabel>

        <FieldLabel
          label="API Key"
          trailing={
            preset.hasApiKey ? (
              <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 normal-case">
                Stored — leave blank to keep
              </span>
            ) : null
          }
        >
          <div className="relative">
            <input
              type={preset.showApiKey ? "text" : "password"}
              value={preset.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              placeholder={preset.hasApiKey ? "••••••••••••••••" : "Paste key (blank for local endpoints)"}
              autoComplete="off"
              className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 pr-10 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
            />
            <button
              type="button"
              onClick={() => onUpdate({ showApiKey: !preset.showApiKey })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors p-1"
              title={preset.showApiKey ? "Hide key" : "Show key"}
              aria-label={preset.showApiKey ? "Hide API key" : "Show API key"}
            >
              {preset.showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </FieldLabel>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onFetchModels}
          disabled={preset.isFetching || !preset.endpoint}
          className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-slate-300 border border-white/10 font-mono text-xs font-bold px-3 py-1.5 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
        >
          {preset.isFetching ? (
            <RefreshCw size={11} className="animate-spin text-cyan-400" />
          ) : (
            <Terminal size={11} className="text-cyan-400" />
          )}
          <span>{preset.isFetching ? "Fetching..." : "Fetch Models"}</span>
        </button>
        {preset.fetchResult && (
          <span
            className={`text-[10px] font-mono ${
              preset.fetchResult.success ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {preset.fetchResult.message}
          </span>
        )}
      </div>

      <ModelPicker
        label="Chat Model"
        accent="cyan"
        models={preset.modelsCache}
        value={preset.chatModel}
        onChange={(v) => onUpdate({ chatModel: v })}
        isActive={isActiveChat}
        canActivate={canActivateChat}
        onSetActive={onSetActiveChat}
      />

      <ModelPicker
        label="Embedding Model"
        accent="indigo"
        models={preset.modelsCache}
        value={preset.embeddingModel}
        onChange={(v) => onUpdate({ embeddingModel: v })}
        isActive={isActiveEmbedding}
        canActivate={canActivateEmbedding}
        onSetActive={onSetActiveEmbedding}
      />
    </div>
  );
}

function FieldLabel({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-mono text-slate-400 flex items-center gap-2">
        <span>{label}</span>
        {trailing}
      </label>
      {children}
    </div>
  );
}

function ModelPicker({
  label,
  accent,
  models,
  value,
  onChange,
  isActive,
  canActivate,
  onSetActive,
}: {
  label: string;
  accent: "cyan" | "indigo";
  models: RemoteModel[] | null;
  value: string;
  onChange: (v: string) => void;
  isActive: boolean;
  canActivate: boolean;
  onSetActive: () => void;
}) {
  const [filter, setFilter] = useState("");
  const accentText = accent === "cyan" ? "text-cyan-400" : "text-indigo-400";
  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";
  const accentBg = accent === "cyan" ? "bg-cyan-500/10" : "bg-indigo-500/10";
  const accentRing = accent === "cyan" ? "ring-cyan-500/30" : "ring-indigo-500/30";

  const filtered = (models || []).filter((m) =>
    filter ? m.id.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const showList = models !== null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase font-mono text-slate-400">{label}</label>
        <button
          onClick={onSetActive}
          disabled={!canActivate}
          className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded border transition-all flex items-center gap-1 ${
            isActive
              ? `${accentBg} ${accentBorder} ${accentText}`
              : canActivate
              ? "border-white/10 text-slate-400 hover:bg-white/5 cursor-pointer"
              : "border-white/5 text-slate-600 cursor-not-allowed"
          }`}
          title={canActivate ? "Toggle active for this role" : "Pick a model first"}
        >
          {isActive && <CheckCircle2 size={9} />}
          <span>{isActive ? "Active" : canActivate ? "Set Active" : "Pick model first"}</span>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!showList}
            placeholder={showList ? `Filter ${models!.length} models...` : "Click 'Fetch Models' to populate"}
            className="w-full bg-slate-900 border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none disabled:opacity-50"
          />
        </div>
        {value && (
          <div
            className={`text-[10px] font-mono px-2 py-1 rounded border bg-slate-950 ${accentBorder} ${accentText} max-w-[50%] truncate`}
            title={value}
          >
            {value}
          </div>
        )}
      </div>
      {showList && (
        <div className="max-h-32 overflow-y-auto bg-slate-950/65 border border-white/5 rounded-lg">
          {filtered.length === 0 ? (
            <div className="p-2 text-[10px] text-slate-500 font-mono">No models match filter.</div>
          ) : (
            filtered.slice(0, 100).map((m) => (
              <button
                key={m.id}
                onClick={() => onChange(m.id)}
                className={`w-full text-left px-3 py-1 text-[11px] font-mono transition-colors flex items-center justify-between gap-2 ${
                  value === m.id
                    ? `${accentBg} ${accentText}`
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <span className="truncate">{m.id}</span>
                {value === m.id && (
                  <span className="text-[9px] uppercase shrink-0 flex items-center gap-1">
                    <CheckCircle2 size={9} /> Selected
                  </span>
                )}
              </button>
            ))
          )}
          {filtered.length > 100 && (
            <div className="p-1.5 text-[10px] text-slate-500 font-mono text-center border-t border-white/5">
              Showing first 100 of {filtered.length} — refine filter.
            </div>
          )}
        </div>
      )}
      {isActive && (
        <div className={`text-[9px] font-mono ${accentText} flex items-center gap-1 ring-1 ${accentRing} ${accentBg} px-2 py-0.5 rounded`}>
          <CheckCircle2 size={9} /> Currently active for {label.toLowerCase()}
        </div>
      )}
    </div>
  );
}

function ExplanatoryCard() {
  return (
    <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5 space-y-3">
      <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
        <Sparkles size={13} className="text-cyan-400" />
        <span>How Presets Work</span>
      </h4>
      <ul className="space-y-2 text-[11px] text-slate-400 leading-relaxed pl-3 list-disc">
        <li>
          <strong className="text-slate-300">Multiple providers:</strong> configure OpenRouter, Ollama, LM Studio, etc. Each preset stores its own endpoint, key, and model selection.
        </li>
        <li>
          <strong className="text-slate-300">Independent roles:</strong> chat (PR review loop) and embedding (semantic search) can use different providers — e.g. OpenRouter for chat + local Ollama for embeddings.
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
