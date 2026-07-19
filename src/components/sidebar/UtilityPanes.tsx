"use client";

import { useEffect, useState } from "react";
import { Activity, ChevronUp, LifeBuoy, Loader2, LogOut, Scale } from "lucide-react";
import { authClient } from "../../lib/auth-client";
import { fetchJson } from "../../lib/http";

/**
 * GitHub App connection pane — bottom of the sidebar. Shows the
 * install state and the Connect / Disconnect actions. Pulled out of
 * DashboardSidebar.tsx to keep the file under the 500-line cap
 * (#69 PR 3).
 */
export function GithubConnectionPane() {
  const [connection, setConnection] = useState<{ connected: boolean; installationId?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchConnection = async () => {
    try {
      const res = await fetchJson("/api/github/connection");
      if (res.ok) {
        const data = await res.json();
        setConnection(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConnection();
  }, []);

  // Re-fetch after OAuth callback redirects back
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github_oauth") === "success") {
      fetchConnection();
      // Clean up URL params without full reload
      const url = new URL(window.location.href);
      url.searchParams.delete("github_oauth");
      url.searchParams.delete("installation_id");
      url.searchParams.delete("repos");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const handleConnect = () => {
    window.location.href = "/api/github/oauth/start";
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Disconnect GitHub? This will remove the OAuth connection.")) return;
    try {
      const res = await fetchJson("/api/github/oauth/disconnect", { method: "POST" });
      if (res.ok) {
        setConnection({ connected: false });
      }
    } catch {
      // silently fail
    }
  };

  return (
    <div className="p-4 border-t border-white/5 bg-slate-950/45">
      <h2 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-extrabold font-mono mb-3">
        GitHub
      </h2>
      {loading ? (
        <div className="flex items-center gap-2 text-[10px] text-slate-600 font-mono">
          <Loader2 size={10} className="animate-spin" />
          <span>Checking connection…</span>
        </div>
      ) : connection?.connected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[10px] text-emerald-400 font-mono">
            <Activity size={12} />
            <span>Connected</span>
          </div>
          {connection.installationId && (
            <div className="text-[8px] text-slate-600 font-mono">
              Installation: {connection.installationId.slice(0, 8)}…
            </div>
          )}
          <button
            onClick={handleDisconnect}
            className="w-full text-[9px] bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 py-1.5 rounded font-mono transition-colors cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          className="w-full text-[9px] bg-slate-900 hover:bg-slate-800 text-slate-300 border border-white/10 py-1.5 rounded font-mono transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <span>Connect GitHub</span>
        </button>
      )}
    </div>
  );
}

/** Compact account and project-help menu pinned to the sidebar bottom. */
export function AccountMenuPane() {
  const [isOpen, setIsOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      window.location.assign("/login");
    } catch {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="relative p-3 border-t border-white/5 bg-slate-950/45">
      {isOpen && (
        <div className="absolute bottom-[calc(100%-4px)] left-3 right-3 rounded-lg border border-white/10 bg-[#151A24] p-1.5 shadow-xl shadow-black/30">
          <a href="https://github.com/darrenedward/Dragnet/issues" target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 rounded-md px-3 text-[10px] font-mono text-slate-300 hover:bg-white/5 hover:text-white">
            <LifeBuoy size={13} className="text-cyan-400" />
            <span>Support &amp; Issues</span>
          </a>
          <a href="https://github.com/darrenedward/Dragnet/blob/main/LICENSE" target="_blank" rel="noreferrer" className="flex min-h-11 items-center gap-2 rounded-md px-3 text-[10px] font-mono text-slate-300 hover:bg-white/5 hover:text-white">
            <Scale size={13} className="text-indigo-400" />
            <span>AGPLv3 License</span>
          </a>
          <button onClick={handleSignOut} disabled={isSigningOut} className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-[10px] font-mono text-rose-300 hover:bg-rose-500/10 disabled:cursor-wait disabled:opacity-60">
            {isSigningOut ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
            <span>{isSigningOut ? "Signing out…" : "Logout"}</span>
          </button>
        </div>
      )}
      <button onClick={() => setIsOpen((open) => !open)} aria-expanded={isOpen} aria-haspopup="menu" className="flex min-h-11 w-full items-center justify-between rounded-lg border border-white/10 bg-slate-900/60 px-3 text-left hover:bg-slate-800/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70">
        <span>
          <span className="block text-[10px] font-extrabold uppercase tracking-[0.2em] text-slate-400 font-mono">Dragnet</span>
          <span className="block text-[9px] text-slate-600 font-mono">Help, license &amp; account</span>
        </span>
        <ChevronUp size={14} className={`text-slate-500 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
    </div>
  );
}
