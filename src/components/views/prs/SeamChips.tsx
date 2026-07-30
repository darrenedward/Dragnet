"use client";

import { buildSeamChips, type SeamChip, type SeamChipInput, type SeamTone } from "../../../lib/seamChips";

const TONE_CLASS: Record<SeamTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
  warn: "bg-amber-500/10 text-amber-300 border-amber-500/25",
  fail: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  pending: "bg-slate-500/10 text-slate-400 border-slate-500/25",
  na: "bg-slate-800/40 text-slate-500 border-slate-700/40",
};

const DOT_CLASS: Record<SeamTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  fail: "bg-rose-400",
  pending: "bg-slate-400",
  na: "bg-slate-600",
};

function Chip({ chip }: { chip: SeamChip }) {
  return (
    <span
      title={chip.title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono font-bold uppercase text-[8px] leading-none ${TONE_CLASS[chip.tone]}`}
    >
      <span className={`w-1 h-1 rounded-full shrink-0 ${DOT_CLASS[chip.tone]}`} />
      <span className="text-slate-500 font-semibold normal-case tracking-tight">{chip.label}</span>
      <span>{chip.detail}</span>
    </span>
  );
}

export default function SeamChips({ input }: { input: SeamChipInput }) {
  const chips = buildSeamChips(input);
  return (
    <div
      role="status"
      aria-label="Pipeline seams"
      className="flex items-center gap-1 flex-wrap"
    >
      {chips.map((chip) => (
        <Chip key={chip.id} chip={chip} />
      ))}
    </div>
  );
}

export type { SeamChipInput };
