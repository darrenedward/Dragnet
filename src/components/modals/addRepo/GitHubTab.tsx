"use client";

import { useState, useEffect } from "react";
import { Github, Loader2, Search, Lock, Unlock } from "lucide-react";
import { inputClass, Field } from "./shared";

interface GitHubRepo {
  id: number;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  cloneUrl: string;
}

interface Props {
  onRepoSelect: (repoId: number, defaultBranch: string) => void;
  newBaseBranch: string;
  setNewBaseBranch: (v: string) => void;
  newBranchPattern: string;
  setNewBranchPattern: (v: string) => void;
  newTriggerMode: "auto" | "mention";
  setNewTriggerMode: (v: "auto" | "mention") => void;
  newQuietPeriod: number;
  setNewQuietPeriod: (n: number) => void;
}

export default function GitHubTab({
  onRepoSelect,
  newBaseBranch,
  setNewBaseBranch,
  newBranchPattern,
  setNewBranchPattern,
  newTriggerMode,
  setNewTriggerMode,
  newQuietPeriod,
  setNewQuietPeriod,
}: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchRepos = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/github/repos");
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Failed to fetch repos" }));
          setError(data.error || "Failed to fetch repos");
          return;
        }
        const data = await res.json();
        if (!cancelled && data.repos) {
          setRepos(data.repos);
        }
      } catch (err) {
        if (!cancelled) {
          setError("Failed to connect to GitHub API");
          console.error(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchRepos();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredRepos = repos.filter((repo) =>
    repo.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description && repo.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleRepoClick = (repo: GitHubRepo) => {
    setSelectedRepoId(repo.id);
    onRepoSelect(repo.id, repo.defaultBranch);
    if (!newBaseBranch) {
      setNewBaseBranch(repo.defaultBranch);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin text-cyan-400" />
        <span className="ml-2 text-xs text-slate-500 font-mono">Fetching GitHub repos...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 bg-rose-950/30 border border-rose-800/20 text-rose-400 rounded text-xs">
        <p className="font-bold mb-1">Error loading GitHub repos</p>
        <p className="text-rose-300">{error}</p>
        <p className="mt-2 text-rose-400/70">Please connect GitHub in the sidebar first.</p>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="p-3 bg-slate-950/50 border border-white/5 rounded text-xs text-slate-500">
        <p>No repositories found in your GitHub App installation.</p>
        <p className="mt-1 text-slate-600">Make sure your GitHub user has access to repos.</p>
      </div>
    );
  }

  return (
    <>
      <Field label="Select Repository">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            type="text"
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={`${inputClass} pl-8`}
          />
        </div>
        <div className="mt-2 max-h-48 overflow-y-auto border border-white/10 rounded bg-slate-950/50">
          {filteredRepos.length === 0 ? (
            <div className="p-3 text-xs text-slate-600 text-center">No matching repositories</div>
          ) : (
            filteredRepos.map((repo) => (
              <button
                key={repo.id}
                type="button"
                onClick={() => handleRepoClick(repo)}
                className={`w-full text-left p-2 border-b border-white/5 last:border-b-0 transition-all flex items-start gap-2 hover:bg-white/5 ${
                  selectedRepoId === repo.id ? "bg-cyan-500/10 border-l-2 border-l-cyan-400" : ""
                }`}
              >
                <div className="shrink-0 mt-0.5">
                  {repo.private ? (
                    <Lock size={12} className="text-amber-500" />
                  ) : (
                    <Unlock size={12} className="text-emerald-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-300 truncate">{repo.fullName}</div>
                  {repo.description && (
                    <div className="text-[9px] text-slate-600 truncate">{repo.description}</div>
                  )}
                </div>
                {selectedRepoId === repo.id && (
                  <div className="text-cyan-400">
                    <Github size={14} />
                  </div>
                )}
              </button>
            ))
          )}
        </div>
        <p className="text-[9px] text-slate-600 mt-1">
          {selectedRepoId
            ? `Selected: ${repos.find((r) => r.id === selectedRepoId)?.fullName}`
            : "Select a repository to import"}
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Base Branch">
          <input
            type="text"
            placeholder={repos[0]?.defaultBranch || "main"}
            value={newBaseBranch}
            onChange={(e) => setNewBaseBranch(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Branch Matcher">
          <input
            type="text"
            placeholder="feature/*"
            value={newBranchPattern}
            onChange={(e) => setNewBranchPattern(e.target.value)}
            className={`${inputClass} text-slate-300`}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Listener Trigger">
          <select
            value={newTriggerMode}
            onChange={(e) => setNewTriggerMode(e.target.value as "auto" | "mention")}
            className={`${inputClass} text-slate-300 cursor-pointer`}
          >
            <option value="auto">auto pipeline</option>
            <option value="mention">@PRBot mention</option>
          </select>
        </Field>
        <Field label="Quiet Cooldown (sec)">
          <input
            type="number"
            min={1}
            max={600}
            value={newQuietPeriod}
            onChange={(e) => setNewQuietPeriod(Number(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>
    </>
  );
}
