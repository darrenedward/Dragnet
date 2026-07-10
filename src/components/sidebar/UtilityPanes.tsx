"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";
import type { LlmPresetsState } from "../../lib/types";
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

/**
 * LLM router pane — bottom of the sidebar. Shows the active chat
 * preset + a "Configure" link to the LLM Settings tab.
 */
export function LlmRouterPane({
  state,
  onOpenSettings,
}: {
  state: LlmPresetsState | null;
  onOpenSettings: () => void;
}) {
  const activeChat = state?.presets.find((p) => p.id === state.activeChatPresetId) || null;
  const chatModel = activeChat?.chatModel || "";
  const shortModel = chatModel.split("/").pop() || chatModel;

  return (
    <div className="p-4 border-white/5 bg-slate-950/45 border-t">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-extrabold font-mono">
          LLM Router
        </h2>
        <button
          onClick={onOpenSettings}
          className="text-[9px] text-cyan-400 hover:text-cyan-300 font-mono uppercase tracking-wider flex items-center gap-1"
          title="Open LLM Settings tab"
        >
          <span>Configure</span>
        </button>
      </div>
      <div className="bg-slate-900/60 p-2.5 rounded-lg border border-white/5">
        <div className="text-[8px] text-slate-500 uppercase font-mono block mb-0.5">Active Chat Model</div>
        {activeChat && chatModel ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-cyan-400 font-mono font-bold truncate" title={`${activeChat.name} · ${chatModel}`}>
              {activeChat.name} · {shortModel}
            </span>
            {activeChat.hasApiKey ? (
              <span className="text-[8px] text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded border border-emerald-500/20 font-mono uppercase shrink-0">
                Key Set
              </span>
            ) : (
              <span className="text-[8px] text-amber-400 bg-amber-500/10 px-1 py-0.5 rounded border border-amber-500/20 font-mono uppercase shrink-0">
                No Key
              </span>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-slate-600 font-mono italic">
            Not configured —{" "}
            <button onClick={onOpenSettings} className="text-cyan-400 hover:underline not-italic">
              set up
            </button>
          </div>
        )}
        {activeChat?.endpoint && (
          <div className="text-[8px] text-slate-600 font-mono truncate mt-1">
            {activeChat.endpoint.replace(/^https?:\/\//, "").split("/")[0]}
          </div>
        )}
      </div>
    </div>
  );
}
