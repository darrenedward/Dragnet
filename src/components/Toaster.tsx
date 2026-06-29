"use client";

/**
 * Fixed-position toast stack. Mounted once at the App root so any module
 * that calls `toast.error()` etc. (via src/lib/toast.ts) gets a visible
 * surface. Auto-dismissal + dedup happens in the store; this component
 * is purely rendering.
 *
 * Position: bottom-right, max width ~28rem. Stacks vertically with the
 * newest at the bottom. Each toast has a manual X to dismiss early.
 */

import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { dismiss, useToasts, type ToastSeverity } from "../lib/toast";

const SEVERITY_ICON: Record<ToastSeverity, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: AlertCircle,
};

const SEVERITY_CLASS: Record<ToastSeverity, string> = {
  info: "border-cyan-500/30 bg-cyan-950/60 text-cyan-200",
  success: "border-emerald-500/30 bg-emerald-950/60 text-emerald-200",
  warn: "border-amber-500/30 bg-amber-950/60 text-amber-200",
  error: "border-rose-500/30 bg-rose-950/60 text-rose-200",
};

const SEVERITY_ICON_CLASS: Record<ToastSeverity, string> = {
  info: "text-cyan-400",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-rose-400",
};

export default function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md pointer-events-none"
    >
      {toasts.map((t) => {
        const Icon = SEVERITY_ICON[t.severity];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-lg border text-xs font-mono shadow-xl backdrop-blur-sm ${SEVERITY_CLASS[t.severity]}`}
          >
            <Icon size={14} className={`shrink-0 mt-0.5 ${SEVERITY_ICON_CLASS[t.severity]}`} />
            <span className="flex-1 leading-relaxed">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="opacity-50 hover:opacity-100 shrink-0 mt-0.5 cursor-pointer"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
