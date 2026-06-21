"use client";

import { Eye, EyeOff, RefreshCw, Terminal } from "lucide-react";
import { DEFAULT_ENDPOINT, type WorkingPreset } from "./shared";

/**
 * Provider-level config: name, endpoint, api key, and a Fetch Models
 * button that pulls the catalog from the upstream /v1/models endpoint.
 *
 * The eye toggle reveals the apiKey field. The "Stored — leave blank to
 * keep" badge is shown when the server already has a key for this preset
 * and the user hasn't typed a new one.
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
