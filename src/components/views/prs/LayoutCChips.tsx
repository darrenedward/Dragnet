"use client";

import type { LayoutCHeaderChip } from "../../../lib/layoutCHeaderChips";
import type { LayoutCPillTone } from "../../../lib/layoutCPills";

const TONE_CLASS: Record<LayoutCPillTone, string> = {
  green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  red: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  blue: "bg-sky-500/10 text-sky-300 border-sky-500/35",
};

export function LayoutCPill({
  chip,
  compact,
}: {
  chip: Pick<LayoutCHeaderChip, "label" | "tone" | "tooltip">;
  compact?: boolean;
}) {
  return (
    <span
      title={chip.tooltip}
      className={`${compact ? "px-1.5 py-0 text-[8px]" : "px-2 py-0.5 text-[9px]"} rounded-full uppercase font-mono font-bold border inline-flex items-center gap-1 ${TONE_CLASS[chip.tone]}`}
    >
      {chip.label}
    </span>
  );
}

export default function LayoutCChips({ chips }: { chips: LayoutCHeaderChip[] }) {
  return (
    <div
      role="status"
      aria-label="PR status"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => (
        <LayoutCPill key={chip.id} chip={chip} />
      ))}
    </div>
  );
}
