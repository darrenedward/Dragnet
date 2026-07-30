"use client";

import type { ProtoPr, ProtoRepo } from "./mockData";
import { Actions, MergeChip, pill, PrIdentity } from "./atoms";

/** A — Minimal: status + one merge chip */
export function VariantA({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-2 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {pill("bg-slate-500/10 text-slate-300 border-slate-500/25", pr.status)}
            {blocked
              ? pill("bg-amber-500/10 text-amber-300 border-amber-500/30", "Blocked · clone")
              : (
                <MergeChip pr={pr} />
              )}
          </div>
          <PrIdentity pr={pr} />
        </div>
        <Actions disabled={blocked} />
      </div>
    </div>
  );
}

/** B — Same PR card; health only in strip above */
export function VariantB({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  return <VariantA repo={repo} pr={pr} />;
}

/** C — Status card layout */
export function VariantC({ repo, pr }: { repo: ProtoRepo; pr: ProtoPr }) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
        <div className="space-y-2">
          <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">PR status</div>
          <div className="text-sm font-mono font-bold text-white">{pr.status}</div>
          <div
            className={`text-sm font-mono font-bold ${
              blocked ? "text-amber-300" : pr.mergeReady ? "text-emerald-400" : "text-amber-300"
            }`}
          >
            {blocked
              ? "Blocked · clone failed"
              : pr.mergeReady
                ? `Merge ready · ${pr.rating}/10`
                : pr.rating != null
                  ? `Not ready · ${pr.rating}/10`
                  : "Not ready · no score"}
          </div>
          {!pr.mergeReady && pr.mergeReason && (
            <p className="text-[11px] font-mono text-slate-500 max-w-md">{pr.mergeReason}</p>
          )}
        </div>
        <div className="space-y-2 sm:text-right">
          <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">Actions</div>
          <Actions disabled={blocked} />
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-white/5">
        <PrIdentity pr={pr} />
      </div>
    </div>
  );
}
