"use client";

import type { ProtoPr, ProtoRepo } from "./mockData";
import { Actions, MainStatusRow, PrIdentity } from "./atoms";

/** C — preferred: status card, chips with tooltips, two-line identity */
export function VariantC({
  repo,
  pr,
  queuePos,
}: {
  repo: ProtoRepo;
  pr: ProtoPr;
  queuePos?: number | null;
}) {
  const blocked = !repo.cloneOk;
  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl space-y-4">
      <div className="space-y-2 min-w-0">
        <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">
          Active pull request
        </div>
        {/* chips + actions on one row, vertically centered */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <MainStatusRow repo={repo} pr={pr} queuePos={queuePos} />
          <Actions disabled={blocked} />
        </div>
      </div>
      <div className="pt-3 border-t border-white/5">
        <PrIdentity pr={pr} />
      </div>
    </div>
  );
}

/** A/B kept as thin aliases so switcher still works — both render C */
export function VariantA(props: {
  repo: ProtoRepo;
  pr: ProtoPr;
  queuePos?: number | null;
}) {
  return <VariantC {...props} />;
}

export function VariantB(props: {
  repo: ProtoRepo;
  pr: ProtoPr;
  queuePos?: number | null;
}) {
  return <VariantC {...props} />;
}
