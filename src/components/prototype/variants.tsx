"use client";

import type { ProtoPr, ProtoRepo } from "./mockData";
import { Actions, MainStatusRow, PrIdentity, pill } from "./atoms";

/** A — chip row + title + actions (production-like, decluttered) */
export function VariantA({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {pill("bg-slate-500/10 text-slate-300 border-slate-500/25", pr.status)}
            <MainStatusRow repo={repo} pr={pr} />
          </div>
          <PrIdentity pr={pr} />
        </div>
        <Actions disabled={blocked} />
      </div>
    </div>
  );
}

/** B — chips only (no status word duplicate); same otherwise */
export function VariantB({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl space-y-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2 min-w-0 flex-1">
          <MainStatusRow repo={repo} pr={pr} />
          <PrIdentity pr={pr} />
        </div>
        <Actions disabled={blocked} />
      </div>
    </div>
  );
}

/** C — two-column status card */
export function VariantC({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
        <div className="space-y-2">
          <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">
            Active pull request
          </div>
          <MainStatusRow repo={repo} pr={pr} />
          {!pr.mergeReady && pr.mergeReason && (
            <p className="text-[11px] font-mono text-slate-500 max-w-md">{pr.mergeReason}</p>
          )}
        </div>
        <Actions disabled={blocked} />
      </div>
      <div className="pt-3 border-t border-white/5">
        <PrIdentity pr={pr} />
      </div>
    </div>
  );
}
