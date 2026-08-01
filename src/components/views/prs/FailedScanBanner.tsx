"use client";

import { AlertTriangle, RotateCcw, Zap } from "lucide-react";
import type { ScanTerminalOutcome } from "../../../lib/scanTerminalOutcome";

/**
 * Hard-fail / quality_failure banner (issue #140).
 *
 * Primary CTA is Re-scan; Force is secondary when cache/lock bypass is needed.
 * Never pair this with a green "Scan run completed" banner.
 */
interface Props {
  outcome: Pick<
    ScanTerminalOutcome,
    "class" | "reason" | "reasonKind" | "systemWarn" | "primaryCta" | "label"
  >;
  isScanning: boolean;
  onRescan: () => void;
  onForceRescan: () => void;
  forceAvailable?: boolean;
}

function reasonKindLabel(kind: string): string {
  switch (kind) {
    case "quality":
      return "Quality";
    case "transport":
      return "Transport";
    case "gate":
      return "Gate";
    case "queue":
      return "Queue";
    case "infrastructure":
      return "Infrastructure";
    default:
      return "Failure";
  }
}

export default function FailedScanBanner({
  outcome,
  isScanning,
  onRescan,
  onForceRescan,
  forceAvailable = true,
}: Props) {
  const detail = outcome.systemWarn || outcome.reason;
  const kind = reasonKindLabel(outcome.reasonKind);

  return (
    <div className="mt-3 p-3 bg-rose-500/[0.06] border border-rose-500/35 rounded-lg text-xs font-mono">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={14} className="text-rose-400 shrink-0 mt-0.5" />
        <div className="flex-1 text-rose-100/90 space-y-1">
          <div>
            <strong className="text-rose-300">{outcome.label || "Failed"}.</strong>{" "}
            <span className="text-rose-300/80">[{kind}]</span>{" "}
            <span className="text-rose-200/85">{detail}</span>
          </div>
          <div className="text-rose-200/60">
            This is not a completed AI pass. Re-scan to retry; use Force when locks or cache block recovery.
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 ml-6">
        <button
          type="button"
          onClick={onRescan}
          disabled={isScanning}
          className="bg-rose-500/25 hover:bg-rose-500/35 border border-rose-500/45 text-rose-100 px-2.5 py-1 rounded font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          title={isScanning ? "Scan already in progress…" : "Re-scan this pull request"}
        >
          <RotateCcw size={11} />
          <span>Re-scan</span>
        </button>
        {forceAvailable && (
          <button
            type="button"
            onClick={onForceRescan}
            disabled={isScanning}
            className="bg-transparent hover:bg-rose-500/10 border border-rose-500/30 text-rose-300/85 px-2.5 py-1 rounded font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              isScanning
                ? "Scan already in progress…"
                : "Force re-scan: clear locks, bypass cache, admit a fresh job"
            }
          >
            <Zap size={11} />
            <span>Force</span>
          </button>
        )}
      </div>
    </div>
  );
}
