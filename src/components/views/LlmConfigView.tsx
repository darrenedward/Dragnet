"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Cpu, Eye, EyeOff, RefreshCw, Search, Sparkles, Terminal } from "lucide-react";

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

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

export default function LlmConfigView() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [models, setModels] = useState<RemoteModel[] | null>(null);
  const [chatFilter, setChatFilter] = useState("");
  const [embeddingFilter, setEmbeddingFilter] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchResult | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/config");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.endpoint) setEndpoint(data.endpoint);
        if (data.chatModel) setChatModel(data.chatModel);
        if (data.embeddingModel) setEmbeddingModel(data.embeddingModel);
        setHasApiKey(Boolean(data.hasApiKey));
      } catch (e) {
        console.error("Failed loading LLM config:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFetchModels = async () => {
    setIsFetching(true);
    setFetchResult(null);
    try {
      const res = await fetch("/api/llm/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, apiKey }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const list: RemoteModel[] = data.models || [];
        setModels(list);
        setHasApiKey(true);
        setFetchResult({
          success: true,
          message: `Connected. Catalog returned ${list.length} models from ${endpoint}.`,
          count: list.length,
        });
      } else {
        setFetchResult({
          success: false,
          message: data.error || "Failed to reach endpoint. Check the URL and API key.",
        });
      }
    } catch (err: any) {
      setFetchResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsFetching(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, apiKey, chatModel, embeddingModel }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const msg = data.message || "Saved. Restart the dev server to apply.";
        setSaveResult({ success: true, message: msg });
        setHasApiKey(true);
        setApiKey("");
      } else {
        setSaveResult({ success: false, message: data.error || "Failed applying config." });
      }
    } catch (err: any) {
      setSaveResult({ success: false, message: "Network or Server Error: " + err.message });
    } finally {
      setIsSaving(false);
    }
  };

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
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              LLM Router Configuration
            </h3>
            <p className="text-xs text-slate-400">
              Point GrepLoop at any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio). Pick chat and embedding models from the live catalog. Saved values persist to .env.local and take effect on next server start.
            </p>
          </div>
        </div>

        <ConfigStats
          endpoint={endpoint}
          chatModel={chatModel}
          embeddingModel={embeddingModel}
          hasApiKey={hasApiKey}
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <EndpointField value={endpoint} onChange={setEndpoint} />
            <ApiKeyField
              value={apiKey}
              onChange={setApiKey}
              hasApiKey={hasApiKey}
              showValue={showApiKey}
              onToggleShow={() => setShowApiKey(!showApiKey)}
            />

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                onClick={handleFetchModels}
                disabled={isFetching || !endpoint}
                className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-slate-300 border border-white/10 font-mono text-xs font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
              >
                {isFetching ? (
                  <RefreshCw size={13} className="animate-spin text-cyan-400" />
                ) : (
                  <Terminal size={13} className="text-cyan-400" />
                )}
                <span>{isFetching ? "Fetching..." : "Fetch Models"}</span>
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !endpoint || !chatModel}
                className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
              >
                {isSaving ? <RefreshCw size={13} className="animate-spin" /> : <Cpu size={13} />}
                <span>{isSaving ? "Saving..." : "Save to .env.local"}</span>
              </button>
              <span className="text-[10px] text-slate-500 italic">
                Chat model is required; embedding is optional. Restart dev server after save.
              </span>
            </div>

            {fetchResult && (
              <ResultBanner
                label={fetchResult.success ? "Catalog Retrieved" : "Fetch Failed"}
                result={fetchResult}
                tone={fetchResult.success ? "emerald" : "rose"}
              />
            )}
            {saveResult && (
              <ResultBanner
                label={saveResult.success ? "Configuration Applied" : "Application Failed"}
                result={saveResult}
                tone={saveResult.success ? "cyan" : "rose"}
              />
            )}

            <ModelPicker
              label="Chat Model (required)"
              hint="Used for the PR review agentic loop. Must support tool/function calling for full quality — otherwise falls back to text mode."
              models={models}
              filter={chatFilter}
              setFilter={setChatFilter}
              value={chatModel}
              onChange={setChatModel}
              accent="cyan"
            />

            <ModelPicker
              label="Embedding Model (optional)"
              hint="Used to power semantic search (findSimilar tool). Leave blank to skip embeddings — review loop still works without it."
              models={models}
              filter={embeddingFilter}
              setFilter={setEmbeddingFilter}
              value={embeddingModel}
              onChange={setEmbeddingModel}
              accent="indigo"
            />
          </div>

          <ExplanatoryCard />
        </div>
      </div>
    </motion.div>
  );
}

function ConfigStats({
  endpoint,
  chatModel,
  embeddingModel,
  hasApiKey,
}: {
  endpoint: string;
  chatModel: string;
  embeddingModel: string;
  hasApiKey: boolean;
}) {
  const shortEndpoint = endpoint.replace(/^https?:\/\//, "").split("/")[0];
  const statusLabel = hasApiKey && chatModel ? "Configured" : hasApiKey ? "Partial" : "Not Configured";
  const statusStyles =
    statusLabel === "Configured"
      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
      : statusLabel === "Partial"
      ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
      : "text-slate-400 bg-slate-500/10 border-slate-500/20";

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-slate-950/65 p-4 rounded-xl border border-white/5 mb-6">
      <StatCell label="Endpoint Host" value={shortEndpoint || "—"} valueClass="text-cyan-400" />
      <StatCell label="Chat Model" value={chatModel || "—"} />
      <StatCell label="Embedding" value={embeddingModel || "—"} valueClass="text-indigo-400" />
      <div className="font-mono text-center p-2">
        <div className="text-[10px] text-slate-500 uppercase">Status</div>
        <div className={`text-[10px] font-bold uppercase mt-1 px-1.5 py-0.5 rounded border inline-block ${statusStyles}`}>
          {statusLabel}
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, valueClass = "text-white" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="font-mono text-center md:border-r md:border-white/5 p-2">
      <div className="text-[10px] text-slate-500 uppercase">{label}</div>
      <div className={`text-xs font-bold uppercase mt-1 truncate ${valueClass}`} title={value}>
        {value}
      </div>
    </div>
  );
}

function EndpointField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5 max-w-2xl">
      <label className="text-[10px] uppercase font-mono text-slate-400 block">Endpoint URL</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
        placeholder={DEFAULT_ENDPOINT}
      />
      <p className="text-[10px] text-slate-500 italic">
        OpenAI-compatible base URL. OpenRouter: <code>https://openrouter.ai/api/v1</code>. Ollama:{" "}
        <code>http://localhost:11434/v1</code>. LM Studio: <code>http://localhost:1234/v1</code>.
      </p>
    </div>
  );
}

function ApiKeyField({
  value,
  onChange,
  hasApiKey,
  showValue,
  onToggleShow,
}: {
  value: string;
  onChange: (v: string) => void;
  hasApiKey: boolean;
  showValue: boolean;
  onToggleShow: () => void;
}) {
  return (
    <div className="space-y-1.5 max-w-2xl">
      <label className="text-[10px] uppercase font-mono text-slate-400 block flex items-center gap-2">
        <span>API Key</span>
        {hasApiKey && (
          <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 normal-case">
            Already set — leave blank to keep
          </span>
        )}
      </label>
      <div className="relative">
        <input
          type={showValue ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 pr-10 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
          placeholder={hasApiKey ? "••••••••••••••••" : "Paste API key (e.g. sk-or-v1-...)"}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors p-1"
          title={showValue ? "Hide key" : "Show key"}
          aria-label={showValue ? "Hide API key" : "Show API key"}
        >
          {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-[10px] text-slate-500 italic">
        Stored locally in .env.local. Get an OpenRouter key at{" "}
        <code>openrouter.ai/keys</code>.
      </p>
    </div>
  );
}

function ModelPicker({
  label,
  hint,
  models,
  filter,
  setFilter,
  value,
  onChange,
  accent,
}: {
  label: string;
  hint: string;
  models: RemoteModel[] | null;
  filter: string;
  setFilter: (v: string) => void;
  value: string;
  onChange: (v: string) => void;
  accent: "cyan" | "indigo";
}) {
  const filtered = (models || []).filter((m) =>
    filter ? m.id.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const showList = models !== null;
  const accentText = accent === "cyan" ? "text-cyan-400" : "text-indigo-400";
  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";

  return (
    <div className="space-y-2 max-w-2xl">
      <label className="text-[10px] uppercase font-mono text-slate-400 block">{label}</label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!showList}
            placeholder={showList ? `Filter ${models!.length} models...` : "Click 'Fetch Models' first"}
            className="w-full bg-slate-950 border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none disabled:opacity-50"
          />
        </div>
        {value && (
          <div className={`text-[10px] font-mono px-2 py-1 rounded border bg-slate-950 ${accentBorder} ${accentText} max-w-[50%] truncate`} title={value}>
            {value}
          </div>
        )}
      </div>
      <p className="text-[10px] text-slate-500 italic">{hint}</p>
      {showList && (
        <div className="max-h-44 overflow-y-auto bg-slate-950/65 border border-white/5 rounded-lg">
          {filtered.length === 0 ? (
            <div className="p-3 text-[11px] text-slate-500 font-mono">No models match filter.</div>
          ) : (
            filtered.slice(0, 200).map((m) => (
              <button
                key={m.id}
                onClick={() => onChange(m.id)}
                className={`w-full text-left px-3 py-1.5 text-[11px] font-mono transition-colors flex items-center justify-between gap-2 ${
                  value === m.id
                    ? `bg-cyan-500/10 ${accentText}`
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <span className="truncate">{m.id}</span>
                {value === m.id && <span className="text-[9px] uppercase shrink-0">selected</span>}
              </button>
            ))
          )}
          {filtered.length > 200 && (
            <div className="p-2 text-[10px] text-slate-500 font-mono text-center border-t border-white/5">
              Showing first 200 of {filtered.length} matches — refine filter to see more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultBanner({
  label,
  result,
  tone,
}: {
  label: string;
  result: { success: boolean; message: string };
  tone: "emerald" | "cyan" | "rose";
}) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
      : tone === "cyan"
      ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-400"
      : "bg-rose-500/10 border-rose-500/20 text-rose-400";
  return (
    <div className={`p-4 rounded-lg text-xs font-mono border animate-fadeIn ${toneClass}`}>
      <div className="font-bold uppercase mb-1">{label}</div>
      <div>{result.message}</div>
    </div>
  );
}

function ExplanatoryCard() {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5 space-y-4">
        <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
          <Sparkles size={13} className="text-cyan-400" />
          <span>Why OpenRouter?</span>
        </h4>
        <p className="text-[11px] leading-relaxed text-slate-400">
          OpenRouter exposes one OpenAI-compatible API for hundreds of models from many providers
          (Anthropic, OpenAI, Google, Qwen, Meta, Mistral, etc.). One key, one endpoint, your choice
          of model per scan.
        </p>
        <ul className="space-y-2 text-[10px] text-slate-500 pl-3 list-disc">
          <li>
            <strong className="text-slate-300">Chat model:</strong> drives the 8-iteration review loop with tool calls.
          </li>
          <li>
            <strong className="text-slate-300">Embedding model:</strong> powers semantic code search. Optional — review works without it.
          </li>
          <li>
            <strong className="text-slate-300">Local fallback:</strong> point at Ollama or LM Studio for fully offline review.
          </li>
        </ul>
      </div>
      <div className="p-4 rounded-xl border border-amber-500/10 bg-amber-500/[0.02] text-[11px] text-amber-500/85">
        <h5 className="font-bold font-mono uppercase mb-1 flex items-center gap-1">
          <AlertCircle size={12} />
          <span>Cost Notice</span>
        </h5>
        <span>
          Agentic review loops make multiple LLM calls per scan (up to 8 iterations × tool calls). On paid models expect roughly $0.05–$0.50 per PR. Use a cheap model (e.g. <code className="font-mono bg-amber-500/10 px-1 rounded">qwen/qwen-2.5-coder</code>) for testing.
        </span>
      </div>
      <div className="p-4 rounded-xl border border-amber-500/10 bg-amber-500/[0.02] text-[11px] text-amber-500/85">
        <h5 className="font-bold font-mono uppercase mb-1 flex items-center gap-1">
          <AlertCircle size={12} />
          <span>Restart Required</span>
        </h5>
        <span>
          Config writes to .env.local but the LLM client only reads it at process start. After saving, restart{" "}
          <code className="font-mono bg-amber-500/10 px-1 rounded">npm run dev</code> for the new endpoint to take effect.
        </span>
      </div>
    </div>
  );
}
