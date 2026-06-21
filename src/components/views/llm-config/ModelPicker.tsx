"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Search } from "lucide-react";
import type { RemoteModel, RoleAccent } from "./shared";

/**
 * Searchable model picker for a single role.
 *
 * Behavior:
 *  - Catalog comes from the parent (one fetch per provider, shared between
 *    the two tabs since the same provider could be picked for both roles).
 *  - After a model is picked, the list collapses so the selected value gets
 *    visual focus. Clicking "Change" reopens it.
 *  - Re-expand automatically whenever a fresh catalog arrives (so the user
 *    can see the list right after clicking Fetch Models).
 */
export default function ModelPicker({
  label,
  accent,
  models,
  value,
  onChange,
  isFetching,
}: {
  label: string;
  accent: RoleAccent;
  models: RemoteModel[] | null;
  value: string;
  onChange: (v: string) => void;
  isFetching: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    setIsExpanded(true);
    setFilter("");
  }, [models]);

  const accentText = accent === "cyan" ? "text-cyan-400" : "text-indigo-400";
  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";
  const accentBg = accent === "cyan" ? "bg-cyan-500/10" : "bg-indigo-500/10";

  const filtered = (models || []).filter((m) =>
    filter ? m.id.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  const hasCatalog = models !== null;
  const showList = hasCatalog && (isExpanded || !value);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase font-mono text-slate-400">{label}</label>
        {value && (
          <span
            className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded border ${accentBorder} ${accentText} ${accentBg} flex items-center gap-1`}
          >
            <CheckCircle2 size={9} /> Selected
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!hasCatalog || isFetching}
            placeholder={
              !hasCatalog
                ? "Click 'Fetch Models' above to populate"
                : isFetching
                ? "Loading catalog..."
                : showList
                ? `Filter ${models!.length} models...`
                : "Selected — click Change to pick a different model"
            }
            className="w-full bg-slate-900 border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none disabled:opacity-50"
          />
        </div>
        {value && !showList && (
          <button
            type="button"
            onClick={() => {
              setFilter("");
              setIsExpanded(true);
            }}
            className={`text-[10px] font-mono px-2 py-1 rounded border ${accentBorder} ${accentText} ${accentBg} hover:opacity-80 cursor-pointer shrink-0`}
            title="Reopen model list"
          >
            Change
          </button>
        )}
      </div>

      {value && (
        <div
          className={`text-[10px] font-mono px-2 py-1.5 rounded border bg-slate-950 ${accentBorder} ${accentText} truncate`}
          title={value}
        >
          {value}
        </div>
      )}

      {showList && (
        <div className="max-h-32 overflow-y-auto bg-slate-950/65 border border-white/5 rounded-lg">
          {filtered.length === 0 ? (
            <div className="p-2 text-[10px] text-slate-500 font-mono">No models match filter.</div>
          ) : (
            filtered.slice(0, 100).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setIsExpanded(false);
                }}
                className={`w-full text-left px-3 py-1 text-[11px] font-mono transition-colors flex items-center justify-between gap-2 ${
                  value === m.id
                    ? `${accentBg} ${accentText}`
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <span className="truncate">{m.id}</span>
                {value === m.id && (
                  <span className="text-[9px] uppercase shrink-0 flex items-center gap-1">
                    <CheckCircle2 size={9} />
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
    </div>
  );
}
