"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Folder, KeyRound, Plus, Copy, Trash2 } from "lucide-react";
import type { Repository } from "../../lib/types";

interface UserRepo {
  userId: string;
  repoId: string;
  role: string;
  invitedAt: string;
  repository: {
    id: string;
    name: string;
    status: string;
    indexedAt: string | null;
  };
}

export default function MyReposView() {
  const [userRepos, setUserRepos] = useState<UserRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);
  const [generatedKey, setGeneratedKey] = useState<{ repoId: string; key: string; prefix: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const fetchRepos = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/repos");
      if (!res.ok) throw new Error("Failed to fetch your repos.");
      setUserRepos(await res.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRepos();
  }, []);

  const handleGenerateKey = async (repoId: string) => {
    setGeneratingFor(repoId);
    setGeneratedKey(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `key-${Date.now()}`, repoId }),
      });
      const data = await res.json();
      if (res.ok) {
        setGeneratedKey({ repoId, key: data.key, prefix: data.prefix });
      } else {
        alert(data.error || "Failed to generate key.");
      }
    } catch {
      alert("Failed to generate key.");
    } finally {
      setGeneratingFor(null);
    }
  };

  if (loading) {
    return (
      <motion.div
        key="my-repos-loading"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center justify-center h-64 text-slate-500 font-mono text-xs"
      >
        Loading your repos…
      </motion.div>
    );
  }

  return (
    <motion.div
      key="my-repos-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 min-h-0 space-y-4 p-6"
    >
      <div className="flex items-center gap-3">
        <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg">
          <Folder size={20} />
        </div>
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
            My Repos
          </h3>
          <p className="text-xs text-slate-400">
            Repos you have access to. Generate an API key for each to use the CLI or pre-push hook.
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300 font-mono">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {userRepos.length === 0 ? (
          <div className="text-xs text-slate-600 font-mono italic py-8 text-center">
            No repos assigned yet. Ask an admin to invite you to a repo.
          </div>
        ) : (
          userRepos.map((ur) => (
            <div
              key={ur.repoId}
              className="bg-slate-900/60 border border-white/5 rounded-lg p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-200 font-mono">
                  {ur.repository.name}
                </span>
                <span className="text-[9px] uppercase font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                  {ur.role}
                </span>
              </div>
              <div className="text-[10px] text-slate-500 font-mono">
                Status: {ur.repository.status} · Indexed: {ur.repository.indexedAt ? new Date(ur.repository.indexedAt).toLocaleDateString() : "never"}
              </div>
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => handleGenerateKey(ur.repoId)}
                  disabled={generatingFor === ur.repoId}
                  className="flex items-center gap-1 px-3 py-1.5 bg-cyan-600/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-600/30 text-[10px] font-bold rounded transition-all cursor-pointer disabled:opacity-50"
                >
                  <Plus size={11} />
                  <span>{generatingFor === ur.repoId ? "Generating..." : "Generate API Key"}</span>
                </button>
              </div>
              {generatedKey?.repoId === ur.repoId && (
                <div className="p-2.5 bg-amber-950/30 border border-amber-500/30 text-amber-300 rounded text-xs space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold">New API key — save it now</span>
                    <button
                      onClick={() => {
                        try { navigator.clipboard.writeText(generatedKey.key); } catch {}
                        setCopiedKey(true);
                        setTimeout(() => setCopiedKey(false), 2000);
                      }}
                      className="ml-auto p-1 hover:bg-amber-500/10 rounded text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      {copiedKey ? "✓" : "Copy"}
                    </button>
                  </div>
                  <code className="block bg-black/60 p-2 rounded text-[11px] break-all select-all">
                    {generatedKey.key}
                  </code>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
