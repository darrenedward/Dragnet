"use client";

import { Eye, EyeOff, RefreshCw, Terminal } from "lucide-react";
import { DEFAULT_ENDPOINT, MAX_ITERATIONS_BOUNDS, type WorkingPreset } from "./shared";

/**
 * Provider-level config: name, endpoint, api key, and a Fetch Models
 * button that pulls the catalog from the upstream /v1/models endpoint.
 *
 * The apiKey field shows the actual stored key (masked as password by
 * default). Click the eye to reveal it in plain text. Local endpoints
 * (Ollama, LM Studio) leave the field blank.
 */
export default function ProviderConfig({
  preset,
  onUpdate,
  onFetchModels,
}: {
  preset: WorkingPreset;
  onUpdate: (patch: Partial<WorkingPreset>) => void;
  onFetchModels: () => void;
}) {
  return (
    <div className="space-y-3">
      <FieldLabel label="Provider Name">
        <input
          type="text"
          value={preset.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="e.g. OpenRouter, Ollama Local, LM Studio"
          className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
        />
      </FieldLabel>

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

        <FieldLabel label="API Key">
          <div className="relative">
            <input
              type={preset.showApiKey ? "text" : "password"}
              value={preset.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              placeholder={preset.hasApiKey ? "•••••••• (key on file — enter new to replace)" : "Paste key (blank for local endpoints)"}
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

      <FieldLabel label="Max Iterations (agentic loop cap)">
        <input
          type="number"
          min={MAX_ITERATIONS_BOUNDS.min}
          max={MAX_ITERATIONS_BOUNDS.max}
          step={1}
          value={preset.maxIterations ?? 16}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onUpdate({ maxIterations: undefined });
              return;
            }
            const n = Number(raw);
            if (Number.isFinite(n)) {
              onUpdate({ maxIterations: Math.floor(n) });
            }
          }}
          placeholder="16 (server default)"
          className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
        />
        <p className="text-[10px] text-slate-500 mt-1 font-mono">
          {MAX_ITERATIONS_BOUNDS.min}–{MAX_ITERATIONS_BOUNDS.max} tool calls per review. Lower for fast models (GPT-5: 8), higher for reasoning models (NVIDIA Nemotron: 10).
        </p>
      </FieldLabel>

      <div className="flex items-center gap-3">
        <button
          type="button"
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
    </div>
  );
}

function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-mono text-slate-400">
        {label}
      </label>
      {children}
    </div>
  );
}
