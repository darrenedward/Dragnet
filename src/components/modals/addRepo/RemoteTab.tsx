"use client";

import { inputClass, Field } from "./shared";

interface Props {
  newRepoMode: "ssh" | "pat";
  setNewRepoMode: (v: "ssh" | "pat") => void;
  newCloneUrl: string;
  setNewCloneUrl: (v: string) => void;
  newCloneUrlHttps: string;
  setNewCloneUrlHttps: (v: string) => void;
  newDeployKey: string;
  setNewDeployKey: (v: string) => void;
  newPat: string;
  setNewPat: (v: string) => void;
  newBaseBranch: string;
  setNewBaseBranch: (v: string) => void;
  newBranchPattern: string;
  setNewBranchPattern: (v: string) => void;
  newTriggerMode: "auto" | "mention";
  setNewTriggerMode: (v: "auto" | "mention") => void;
  newQuietPeriod: number;
  setNewQuietPeriod: (n: number) => void;
}

export default function RemoteTab({
  newRepoMode, setNewRepoMode,
  newCloneUrl, setNewCloneUrl,
  newCloneUrlHttps, setNewCloneUrlHttps,
  newDeployKey, setNewDeployKey,
  newPat, setNewPat,
  newBaseBranch, setNewBaseBranch,
  newBranchPattern, setNewBranchPattern,
  newTriggerMode, setNewTriggerMode,
  newQuietPeriod, setNewQuietPeriod,
}: Props) {
  return (
    <>
      <Field label="Clone URL">
        <input
          required
          type="text"
          placeholder={newRepoMode === "ssh" ? "git@github.com:user/repo.git" : "https://github.com/user/repo.git"}
          value={newCloneUrl}
          onChange={(e) => setNewCloneUrl(e.target.value)}
          className={inputClass}
        />
        <p className="text-[9px] text-slate-600 mt-1">
          {newRepoMode === "ssh"
            ? "SSH URL for git clone (used with deploy key)"
            : "HTTPS URL for git clone (PAT will be injected)"}
        </p>
      </Field>

      <Field label="HTTPS URL (for API calls)">
        <input
          type="text"
          placeholder="https://github.com/user/repo.git (if different)"
          value={newCloneUrlHttps}
          onChange={(e) => setNewCloneUrlHttps(e.target.value)}
          className={inputClass}
        />
        <p className="text-[9px] text-slate-600 mt-1">
          For webhook setup via API. Skip if your clone URL is already HTTPS.
        </p>
      </Field>

      <Field label="Auth Mode">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setNewRepoMode("ssh")}
            className={`flex-1 py-2 rounded font-bold text-xs transition-all cursor-pointer ${
              newRepoMode === "ssh"
                ? "bg-cyan-500 text-black shadow-[0_0_8px_rgba(6,182,212,0.3)]"
                : "bg-slate-900 text-slate-400 border border-white/10 hover:bg-slate-800"
            }`}
          >
            SSH Deploy Key
          </button>
          <button
            type="button"
            onClick={() => setNewRepoMode("pat")}
            className={`flex-1 py-2 rounded font-bold text-xs transition-all cursor-pointer ${
              newRepoMode === "pat"
                ? "bg-cyan-500 text-black shadow-[0_0_8px_rgba(6,182,212,0.3)]"
                : "bg-slate-900 text-slate-400 border border-white/10 hover:bg-slate-800"
            }`}
          >
            PAT / Token
          </button>
        </div>
      </Field>

      {newRepoMode === "ssh" ? (
        <Field label="Deploy Key (Private Key)">
          <textarea
            required
            rows={6}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----\n..."
            value={newDeployKey}
            onChange={(e) => setNewDeployKey(e.target.value)}
            className={`${inputClass} font-mono text-[11px] resize-none`}
          />
          <p className="text-[9px] text-slate-600 mt-1">
            Paste the full private key. Stored encrypted at rest using AES-256-GCM.
          </p>
        </Field>
      ) : (
        <Field label="Personal Access Token">
          <input
            required
            type="password"
            placeholder="ghp_... or glpat-..."
            value={newPat}
            onChange={(e) => setNewPat(e.target.value)}
            className={inputClass}
          />
          <p className="text-[9px] text-slate-600 mt-1">
            Must have push access to the repo. Stored encrypted at rest.
          </p>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Base Branch">
          <input
            type="text"
            placeholder="main"
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
