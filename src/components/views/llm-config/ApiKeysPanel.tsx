"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Eye, EyeOff, Key, Plus, Trash2, X, Code, Terminal, Sparkles, Cpu } from "lucide-react";

interface RepoView {
  id: string;
  name: string;
}

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

type ToolId = "claude" | "cursor" | "opencode" | "codex";

interface ToolConfig {
  id: ToolId;
  label: string;
  icon: typeof Code;
}

const tools: ToolConfig[] = [
  { id: "claude", label: "Claude Code", icon: Sparkles },
  { id: "cursor", label: "Cursor", icon: Cpu },
  { id: "opencode", label: "OpenCode", icon: Terminal },
  { id: "codex", label: "Codex", icon: Code },
];

function InstallModal({ tool, origin, apiKey, repoId, onClose }: { tool: ToolId; origin: string; apiKey: string; repoId?: string; onClose: () => void }) {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const copy = (text: string, section: string) => {
    try {
      navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const key = apiKey;
  const baseUrl = repoId ? `${origin}/api/command/${repoId}` : `${origin}/api/command`;

  interface CmdSection { label: string; command: string; }
  const sections: Record<ToolId, { title: string; steps: CmdSection[] }> = {
    claude: {
      title: "Claude Code",
      steps: [
        {
          label: "Install the Dragnet /dragnet skill (run from the Dragnet repo root)",
          command: `cp -r skills/dragnet ~/.claude/skills/`,
        },
        {
          label: "Set your API key (used by the skill, CLI, and pre-push hook)",
          command: `export DRAGNET_API_KEY='${key}'`,
        },
      ],
    },
    cursor: {
      title: "Cursor",
      steps: [
        {
          label: "Cursor has no agent-skill system \u2014 call the Dragnet API directly",
          command: `curl -s ${baseUrl} -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"command":"prlist"}'`,
        },
      ],
    },
    opencode: {
      title: "OpenCode",
      steps: [
        {
          label: "Install the Dragnet /dragnet skill (OpenCode reads ~/.claude/skills)",
          command: `cp -r skills/dragnet ~/.claude/skills/`,
        },
        {
          label: "Set your API key (used by the skill, CLI, and pre-push hook)",
          command: `export DRAGNET_API_KEY='${key}'`,
        },
      ],
    },
    codex: {
      title: "Codex",
      steps: [
        {
          label: "Codex has no agent-skill system — call the Dragnet API directly",
          command: `curl -s ${baseUrl} -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"command":"prlist"}'`,
        },
      ],
    },
  };

  const t = sections[tool];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#0F1219] border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">{t.title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {!apiKey && (
            <div className="space-y-3">
              <p className="text-xs text-slate-400 font-mono">No API key available. Generate one above first.</p>
            </div>
          )}
          {t.steps.map((step, i) => (
            <div key={i} className="space-y-2">
              <p className="text-xs text-slate-400 font-mono">{step.label}</p>
              <div className="relative group">
                <pre className="bg-black/80 rounded-lg p-3 text-[12px] font-mono text-cyan-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed border border-white/5 select-all">
                  {step.command}
                </pre>
                <button
                  onClick={() => copy(step.command, `${tool}-${i}`)}
                  className="absolute top-2 right-2 p-1.5 bg-slate-800/80 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-cyan-400 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
                  title="Copy"
                >
                  {copiedSection === `${tool}-${i}` ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [origin, setOrigin] = useState("http://localhost:3300");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) setKeys(await res.json());
    } catch { /* ignore */ }
  };

  const fetchRepos = async () => {
    try {
      const res = await fetch("/api/repos");
      if (res.ok) setRepos(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    Promise.all([fetchKeys(), fetchRepos()]).finally(() => setIsLoading(false));
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    setNewKeyValue(null);
    try {
      const existing = await (await fetch("/api/keys")).json();
      await Promise.all(
        (existing as { id: string }[]).map((k) =>
          fetch(`/api/keys/${k.id}`, { method: "DELETE" })
        )
      );
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName || "Dragnet API Key" }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewKeyValue(data.key);
        setNewKeyName("");
        await fetchKeys();
      } else {
        setError(data.error);
      }
    } catch {
      setError("Failed to create key.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await fetch(`/api/keys/${id}`, { method: "DELETE" });
      await fetchKeys();
    } catch { /* ignore */ }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 font-mono text-xs">
        Loading API keys...
      </div>
    );
  }

  return (
    <motion.div
      key="api-keys-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 overflow-y-auto space-y-5"
    >
      <div className="p-6 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg">
            <Key size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              API Keys
            </h3>
            <p className="text-xs text-slate-400">
              API keys for remote clients (Claude Code, Cursor, etc.). Set the <code className="text-cyan-400">Authorization: Bearer</code> header when calling Dragnet's endpoints.
            </p>
          </div>
        </div>

        {keys.length > 0 && (
          <div className="space-y-2 mb-6">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Active Keys</h4>
            <div className="space-y-1.5">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-lg border border-white/5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-slate-300">{k.name}</span>
                      <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 font-mono uppercase">Active</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5">{k.prefix}</div>
                    <div className="text-[9px] text-slate-600 font-mono">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : " · Never used"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(k.id)}
                    className="p-2 hover:bg-rose-500/10 rounded-lg text-slate-500 hover:text-rose-400 transition-colors"
                    title="Delete key"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {newKeyValue ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              <p className="text-xs text-amber-300 font-mono font-bold">Save this key — it won't be shown again</p>
            </div>
            <div className="bg-black/60 rounded-lg p-3 text-xs font-mono text-amber-200 break-all select-all leading-relaxed flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {showKey ? newKeyValue : newKeyValue!.replace(/.(?=.{4})/g, "*")}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="p-1.5 hover:bg-amber-500/10 rounded-lg text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  title={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  onClick={() => { try { navigator.clipboard.writeText(newKeyValue!); } catch { const ta = document.createElement("textarea"); ta.value = newKeyValue!; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); } setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  className="p-1.5 hover:bg-amber-500/10 rounded-lg text-amber-400 hover:text-amber-300 transition-colors cursor-pointer"
                  title="Copy to clipboard"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Generate New Key</h4>
            <div className="flex items-center gap-3">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Claude Code"
                className="flex-1 bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
                onKeyDown={(e) => { if (e.key === "Enter" && newKeyName.trim()) handleCreate(); }}
              />
              <button
                onClick={handleCreate}
                disabled={creating || !newKeyName.trim()}
                className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
              >
                <Plus size={13} />
                <span>{creating ? "Creating..." : "Generate Key"}</span>
              </button>
            </div>
            {error && <p className="text-xs text-rose-400 font-mono">{error}</p>}
          </div>
        )}
      </div>

      <div className="p-5 bg-[#0F1219] border border-white/10 rounded-xl">
        <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold mb-3">Connect Your Tools</h4>

        {repos.length > 0 && (
          <div className="mb-4">
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold block mb-1.5">
              Target Repository
            </label>
            <select
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 focus:outline-none focus:border-cyan-500/40"
            >
              <option value="">All repos (pass repoId manually)</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            {selectedRepo && (
              <p className="text-[9px] text-slate-500 font-mono mt-1">
                Install commands will be scoped to this repo. <code className="text-cyan-400">/dragnet 5</code> will use this repo automatically.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {tools.map((t) => {
            const Icon = t.icon;
            const hasKey = newKeyValue !== null;
            return (
              <button
                key={t.id}
                onClick={async () => {
                  if (hasKey) { setActiveTool(t.id); return; }
                  setCreating(true);
                  try {
                    const existing = await (await fetch("/api/keys")).json();
                    await Promise.all(
                      (existing as { id: string }[]).map((k) =>
                        fetch(`/api/keys/${k.id}`, { method: "DELETE" })
                      )
                    );
                    const res = await fetch("/api/keys", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: "Dragnet API Key" }),
                    });
                    const data = await res.json();
                    if (res.ok) setNewKeyValue(data.key);
                    await fetchKeys();
                  } catch { /* ignore */ }
                  setCreating(false);
                  setActiveTool(t.id);
                }}
                className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-xs font-mono transition-all ${
                  hasKey
                    ? "bg-slate-900/60 hover:bg-slate-800 border-white/10 hover:border-cyan-500/30 text-slate-400 hover:text-cyan-300 cursor-pointer"
                    : "bg-slate-900/30 border-white/5 text-slate-600 cursor-pointer hover:border-amber-500/30 hover:text-amber-400"
                }`}
                title={hasKey ? `Configure ${t.label}` : "Click to auto-generate an API key"}
              >
                <Icon size={14} />
                {t.label}
                {!hasKey && <Plus size={10} className="text-amber-500" />}
              </button>
            );
          })}
        </div>
      </div>

      {activeTool && (
        <InstallModal
          tool={activeTool}
          origin={origin}
          apiKey={newKeyValue!}
          repoId={selectedRepo || undefined}
          onClose={() => setActiveTool(null)}
        />
      )}
    </motion.div>
  );
}
