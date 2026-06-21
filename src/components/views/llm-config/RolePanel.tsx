"use client";

import { Plus, Trash2 } from "lucide-react";
import ProviderConfig from "./ProviderConfig";
import ModelPicker from "./ModelPicker";
import type { RoleAccent, WorkingPreset } from "./shared";

/**
 * Renders one role's tab (Chat or Embedding).
 *
 * Layout:
 *  - Active provider dropdown at top (switches which preset is active for
 *    this role; selects into the parent's activeChatId/activeEmbeddingId)
 *  - Editable config for the currently-selected preset (ProviderConfig)
 *  - One ModelPicker scoped to this role only (chatModel or embeddingModel)
 *  - "+ New Provider" creates a blank preset and selects it for this role
 *  - "Delete" removes the preset from storage (blocked if active in either
 *    role — prevents dangling activeChatId/activeEmbeddingId references)
 */
export default function RolePanel({
  role,
  accent,
  presets,
  activePresetId,
  canDeleteActive,
  onSelectActive,
  onAddProvider,
  onDeleteActive,
  onUpdatePreset,
  onFetchModels,
}: {
  role: "chat" | "embedding";
  accent: RoleAccent;
  presets: WorkingPreset[];
  activePresetId: string;
  canDeleteActive: boolean;
  onSelectActive: (id: string) => void;
  onAddProvider: () => void;
  onDeleteActive: () => void;
  onUpdatePreset: (id: string, patch: Partial<WorkingPreset>) => void;
  onFetchModels: (id: string) => void;
}) {
  const active = presets.find((p) => p.id === activePresetId) || presets[0] || null;

  if (!active) {
    return (
      <div className="bg-slate-950/65 rounded-xl border border-dashed border-white/10 p-8 text-center">
        <p className="text-xs text-slate-400 font-mono mb-4">
          No providers configured yet. Add one to pick a {role} model.
        </p>
        <button
          type="button"
          onClick={onAddProvider}
          className="bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 font-mono text-xs font-bold px-4 py-2 rounded-lg inline-flex items-center gap-2 cursor-pointer"
        >
          <Plus size={13} />
          <span>Add Provider</span>
        </button>
      </div>
    );
  }

  const accentBorder = accent === "cyan" ? "border-cyan-500" : "border-indigo-500";
  const modelValue = role === "chat" ? active.chatModel : active.embeddingModel;
  const onModelChange = (v: string) =>
    onUpdatePreset(active.id, role === "chat" ? { chatModel: v } : { embeddingModel: v });
  const roleLabel = role === "chat" ? "Chat Model (PR Reviewer)" : "Embedding Model (Semantic Search)";

  return (
    <div className={`bg-slate-950/65 rounded-xl border ${accentBorder}/30 p-4 space-y-4`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <label className="text-[10px] uppercase font-mono text-slate-400 block mb-1">
            Provider
          </label>
          <select
            value={active.id}
            onChange={(e) => onSelectActive(e.target.value)}
            className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none cursor-pointer"
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || "(unnamed)"} — {p.endpoint.replace(/^https?:\/\//, "").split("/")[0]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onAddProvider}
            className="bg-slate-900 hover:bg-slate-800 text-slate-300 border border-white/10 font-mono text-xs px-2.5 py-2 rounded-lg flex items-center gap-1 cursor-pointer"
            title="Add a new provider preset"
          >
            <Plus size={12} className="text-cyan-400" />
            <span className="hidden sm:inline">New</span>
          </button>
          <button
            type="button"
            onClick={onDeleteActive}
            disabled={!canDeleteActive}
            className="bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-slate-400 hover:text-rose-400 border border-white/10 font-mono text-xs px-2.5 py-2 rounded-lg flex items-center gap-1 cursor-pointer"
            title={
              canDeleteActive
                ? "Delete this provider preset"
                : "Clear this preset's active role first, then delete"
            }
          >
            <Trash2 size={12} />
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>

      <ProviderConfig
        preset={active}
        onUpdate={(patch) => onUpdatePreset(active.id, patch)}
        onFetchModels={() => onFetchModels(active.id)}
      />

      <div className={`pt-3 mt-1 border-t ${accentBorder}/20`}>
        <ModelPicker
          label={roleLabel}
          accent={accent}
          models={active.modelsCache}
          value={modelValue}
          onChange={onModelChange}
          isFetching={active.isFetching}
        />
      </div>
    </div>
  );
}
