"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { PrSizeProfile, PrSizeTier } from "../lib/prSizeProfile";

const TIER_CONFIG: Record<PrSizeTier, {
  label: string;
  className: string;
  Icon: typeof CheckCircle2;
}> = {
  small: {
    label: "Small",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
    Icon: CheckCircle2,
  },
  medium: {
    label: "Medium",
    className: "bg-amber-500/10 text-amber-400 border-amber-500/25",
    Icon: AlertTriangle,
  },
  large: {
    label: "Large",
    className: "bg-orange-500/10 text-orange-300 border-orange-500/25",
    Icon: AlertTriangle,
  },
  oversized: {
    label: "Oversized",
    className: "bg-rose-500/10 text-rose-300 border-rose-500/25",
    Icon: XCircle,
  },
};

export default function PrSizeProfileChip({
  profile,
  compact = false,
}: {
  profile: PrSizeProfile;
  compact?: boolean;
}) {
  const config = TIER_CONFIG[profile.tier];
  const title = `${profile.label}${profile.message ? ` - ${profile.message}` : ""} (${profile.codeFiles}/${profile.totalFiles} changed files counted as code)`;
  const Icon = config.Icon;

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border font-mono font-extrabold uppercase leading-none ${config.className} ${
        compact ? "px-1 py-0.5 text-[7px]" : "px-2 py-0.5 text-[9px]"
      }`}
    >
      <Icon size={compact ? 8 : 10} className="shrink-0" />
      <span>{compact ? config.label.slice(0, 3) : config.label}</span>
    </span>
  );
}
