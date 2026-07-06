"use client";

import { X } from "lucide-react";

interface Props {
  raw: string;
  prefix: string;
  onDismiss: () => void;
}

export default function ApiKeyBanner({ raw, prefix, onDismiss }: Props) {
  return (
    <div className="fixed bottom-6 right-6 z-50 bg-[#0F1219] border border-amber-500/30 rounded-xl p-4 shadow-2xl max-w-md">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        <p className="text-xs text-amber-300 font-mono font-bold">Project API Key — save it now</p>
        <button onClick={onDismiss} className="ml-auto p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer">
          <X size={14} />
        </button>
      </div>
      <p className="text-[10px] text-slate-500 font-mono mb-2">
        This key identifies this project. Set it as <code className="text-cyan-400">DRAGNET_API_KEY</code> in your client environment.
      </p>
      <div className="bg-black/60 rounded-lg p-2.5 text-xs font-mono text-amber-200 break-all select-all leading-relaxed border border-white/5">
        {raw}
      </div>
      <p className="text-[9px] text-slate-600 font-mono mt-1.5">Prefix: {prefix} — Won't be shown again.</p>
    </div>
  );
}
