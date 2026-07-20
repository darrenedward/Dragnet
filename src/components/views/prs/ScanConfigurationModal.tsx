"use client";

import { AlertTriangle, Cpu, Settings, X } from "lucide-react";
import { motion } from "motion/react";

interface Issue {
  role: "chat" | "embedding";
  label: string;
  provider: string | null;
  reason: "missing_provider" | "missing_model" | "missing_api_key";
}

interface Props {
  open: boolean;
  message: string;
  issues: Issue[];
  onOpenSettings: () => void;
  onClose: () => void;
}

export default function ScanConfigurationModal({ open, message, issues, onOpenSettings, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none" role="dialog" aria-modal="true" aria-labelledby="scan-config-title">
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-md overflow-hidden rounded-xl border border-amber-500/30 bg-[#0F1219] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/70 px-5 py-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={17} className="text-amber-300" />
            <h2 id="scan-config-title" className="text-sm font-bold uppercase tracking-tight text-white">
              Review setup required
            </h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-white/5 hover:text-white" aria-label="Close setup warning">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-5 text-sm text-slate-300">
          <p className="leading-relaxed">{message} No scan was started.</p>
          <div className="space-y-2">
            {issues.map((issue) => (
              <div key={issue.role} className="flex items-start gap-2 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2.5">
                <Cpu size={14} className="mt-0.5 shrink-0 text-cyan-400" />
                <div>
                  <div className="font-semibold text-slate-200">{issue.label}</div>
                  <div className="text-xs text-slate-400">
                    {issue.provider ? `${issue.provider}: ` : ""}
                    {issue.reason === "missing_api_key" && "API key is missing."}
                    {issue.reason === "missing_provider" && "No primary provider is selected."}
                    {issue.reason === "missing_model" && "No model is selected."}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Both chat review and codebase embeddings are required before a PR review can run.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 bg-slate-950/40 px-5 py-3">
          <button onClick={onClose} className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/5">
            Close
          </button>
          <button onClick={onOpenSettings} className="flex items-center gap-1.5 rounded-md border border-cyan-300/50 bg-cyan-500 px-3 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-400">
            <Settings size={13} />
            Open LLM Settings
          </button>
        </div>
      </motion.div>
    </div>
  );
}
