"use client";

/**
 * Top-level React error boundary. Catches render-time explosions anywhere
 * in the App subtree and shows a friendly fallback instead of the raw
 * Next.js error overlay. Async errors (fetch, setTimeout, etc.) do NOT
 * trigger this — those are surfaced via the toast store (src/lib/toast.ts)
 * by callers' catch blocks.
 *
 * Class component because React's error-boundary API still requires
 * `getDerivedStateFromError` / `componentDidCatch` — no hook equivalent.
 *
 * Mount <ErrorBoundary> once at the App root so the whole tree is covered.
 */

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Server-side logging hook if/when we add observability. For now,
    // console.error so dev tools see the stack without trapping it.
    console.error("[ErrorBoundary] render crash:", error, info);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-950 text-slate-300 flex flex-col items-center justify-center p-6">
        <AlertTriangle size={48} className="text-rose-500 mb-4" />
        <h1 className="text-lg font-bold font-mono mb-2 text-white">
          Something went wrong.
        </h1>
        <p className="text-xs font-mono text-slate-400 mb-4 max-w-md text-center">
          The dashboard hit an unexpected error. Try reloading the page; if
          the problem persists, contact your administrator.
        </p>
        <pre className="text-[10px] font-mono text-rose-300/80 bg-slate-900 border border-white/10 px-3 py-2 rounded max-w-2xl overflow-auto mb-4">
          {this.state.error.message || String(this.state.error)}
        </pre>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-mono text-xs font-bold rounded flex items-center gap-1.5 cursor-pointer transition-colors"
        >
          <RefreshCw size={12} />
          Reload
        </button>
      </div>
    );
  }
}
