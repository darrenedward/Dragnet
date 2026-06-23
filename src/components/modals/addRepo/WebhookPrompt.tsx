"use client";

import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { CheckCircle, X, Loader2, Globe, AlertTriangle, Copy } from "lucide-react";

interface Props {
  repoName: string;
  repoId: string;
  hasPat: boolean;
  onClose: () => void;
}

interface PublicUrlInfo {
  url: string;
  isLocal: boolean;
}

export default function WebhookPrompt({ repoName, repoId, hasPat, onClose }: Props) {
  const [settingUp, setSettingUp] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [manualInstructions, setManualInstructions] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<PublicUrlInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/public-url")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setPublicUrl(data);
      })
      .catch(() => {
        if (!cancelled) setPublicUrl({ url: "http://localhost:3300", isLocal: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoSetup = async () => {
    setSettingUp(true);
    setResult(null);
    try {
      const res = await fetch(`/api/repos/${repoId}/webhook`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setResult({ success: true, message: `Webhook created (ID: ${data.webhookId})` });
      } else {
        setResult({ success: false, message: data.error || "Auto-setup failed" });
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message });
    } finally {
      setSettingUp(false);
    }
  };

  const handleManual = async () => {
    try {
      const res = await fetch(`/api/repos/${repoId}/webhook/setup-instructions`);
      if (res.ok) {
        const data = await res.json();
        setManualInstructions(data.instructions || "See setup instructions below.");
      } else {
        setManualInstructions("Could not load instructions.");
      }
    } catch (err: any) {
      setManualInstructions("Error: " + err.message);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const tunnelCommand = "cloudflared tunnel --url http://localhost:3300";
  const isLocal = publicUrl?.isLocal ?? true;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 p-4 select-none">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-[#0F1219] border border-white/15 w-full max-w-lg rounded-xl overflow-hidden shadow-2xl"
      >
        <div className="px-5 py-4 bg-slate-950/70 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle size={16} className="text-emerald-400" />
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">Repo Registered</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 text-xs font-mono">
          <p className="text-slate-300">
            <strong className="text-white">{repoName}</strong> has been registered
            {hasPat ? " and is being cloned." : ". It will be cloned once a deploy key or PAT is configured."}
          </p>

          {isLocal && !result && !manualInstructions && (
            <div className="p-3 bg-amber-950/30 border border-amber-700/30 rounded">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                <span className="text-amber-300 font-bold uppercase tracking-tight">
                  Localhost detected — webhook setup needs a tunnel
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed mb-2">
                GitHub/GitLab can't deliver webhooks to <code className="text-slate-300">{publicUrl?.url || "localhost"}</code>.
                Run a Cloudflare Tunnel to expose this server publicly:
              </p>
              <div className="flex items-center gap-2 bg-slate-950 border border-white/10 rounded p-2">
                <code className="flex-1 text-cyan-400 text-[11px] overflow-x-auto">{tunnelCommand}</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(tunnelCommand, "tunnel")}
                  className="shrink-0 p-1 text-slate-400 hover:text-cyan-400 transition-all"
                  title="Copy"
                >
                  {copied === "tunnel" ? <CheckCircle size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>
              <p className="text-slate-500 mt-2 leading-relaxed">
                Copy the tunnel URL it prints, set <code className="text-slate-400">GREPLOOP_PUBLIC_URL=https://xyz.trycloudflare.com</code> in
                <code className="text-slate-400"> .env.local</code>, restart the server, then continue below.
              </p>
            </div>
          )}

          {!isLocal && !result && !manualInstructions && (
            <p className="text-slate-400 flex items-center gap-2">
              <Globe size={14} className="text-cyan-400 shrink-0" />
              Public URL configured (<code className="text-slate-300">{publicUrl?.url}</code>) — webhook delivery is ready.
            </p>
          )}

          <p className="text-slate-400">Set up a webhook so GrepLoop is notified on every push:</p>

          {result && (
            <div className={`p-2 rounded text-xs ${result.success ? "bg-emerald-950/30 border border-emerald-800/20 text-emerald-400" : "bg-rose-950/30 border border-rose-800/20 text-rose-400"}`}>
              {result.message}
            </div>
          )}

          {manualInstructions && (
            <pre className="p-3 bg-slate-950 border border-white/10 rounded text-[10px] text-slate-400 whitespace-pre-wrap max-h-60 overflow-y-auto">
              {manualInstructions}
            </pre>
          )}

          <div className="flex gap-2.5 mt-2">
            {hasPat && !result && !manualInstructions && (
              <button
                onClick={handleAutoSetup}
                disabled={settingUp}
                className="flex-1 bg-cyan-500 hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(6,182,212,0.3)] text-black py-2.5 rounded font-bold transition-all cursor-pointer text-center disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {settingUp && <Loader2 size={14} className="animate-spin" />}
                {settingUp ? "Setting up..." : "Auto-Setup Webhook"}
              </button>
            )}
            {!result && !manualInstructions && (
              <button
                onClick={handleManual}
                className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2.5 rounded font-bold transition-all cursor-pointer text-center"
              >
                Show Manual Instructions
              </button>
            )}
          </div>

          {(result || manualInstructions) && (
            <button
              onClick={onClose}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 py-2.5 rounded font-bold transition-all cursor-pointer text-center"
            >
              Done
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
