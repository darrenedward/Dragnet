"use client";

import { AlertTriangle, Play, RotateCcw } from "lucide-react";

/**
 * Phase 7 — Resume-offer banner for interrupted scans.
 *
 * When the scan endpoint returns `status: "interrupted"`, the dashboard
 * stores the resume metadata and this banner renders on top of the PR's
 * findings panel. Two paths:
 *
 *   - Continue: POST /scan?resume=true. Replays the checkpoint into
 *     runPrScan so the agentic loop picks up from the next iteration
 *     instead of repaying iteration 1. Disabled (and the banner shows
 *     a codeChanged/configChanged warning) when the underlying hash
 *     trio no longer matches the checkpoint.
 *
 *   - Start fresh: POST /scan?fresh=true. Deletes the checkpoint and
 *     starts a brand-new ReviewRun. Always available, even when the
 *     hashes drifted.
 *
 * The banner is scoped to a single PR — switching PRs clears
 * `interruptedScan` from the parent hook, so this component never
 * renders stale state for the wrong PR.
 */
export interface InterruptedScan {
  prId: string;
  runId: string;
  checkpointId: string;
  completedIterations: number;
  totalIterations: number;
  reachedPercent: number;
  lastProvider: string | null;
  lastModel: string | null;
  resumeAllowed: boolean;
  codeChanged: boolean;
  configChanged: boolean;
  message: string;
}

interface Props {
  scan: InterruptedScan;
  isScanning: boolean;
  onContinue: () => void;
  onStartFresh: () => void;
}

export default function InterruptedScanBanner({
  scan,
  isScanning,
  onContinue,
  onStartFresh,
}: Props) {
  const blockReason = scan.codeChanged
    ? "the PR commit has changed since the checkpoint — resume would skip reviewing new code"
    : scan.configChanged
      ? "the review configuration (model/prompt/limits) has changed — resume would mix old and new behavior"
      : null;

  return (
    <div className="mt-3 p-3 bg-amber-500/[0.05] border border-amber-500/30 rounded-lg text-xs font-mono">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 text-amber-200/90 space-y-1">
          <div>
            <strong className="text-amber-300">Scan interrupted.</strong>{" "}
            Resumed progress: iteration {scan.completedIterations}/{scan.totalIterations}
            {scan.reachedPercent > 0 ? ` (${Math.round(scan.reachedPercent)}%)` : ""}
            {scan.lastModel ? ` on ${scan.lastModel}` : ""}.
          </div>
          {blockReason ? (
            <div className="text-amber-300/80">
              <span className="font-bold">Resume blocked:</span> {blockReason}.
            </div>
          ) : (
            <div className="text-amber-200/70">
              Continue from the checkpoint to avoid repaying token cost, or start fresh to re-scan from scratch.
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2.5 ml-6">
        <button
          onClick={onContinue}
          disabled={!scan.resumeAllowed || isScanning}
          className="bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 px-2.5 py-1 rounded font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            !scan.resumeAllowed
              ? "Resume blocked — code or config changed since checkpoint"
              : isScanning
                ? "Scan already in progress…"
                : "Resume the scan from the last checkpoint"
          }
        >
          <Play size={11} />
          <span>Continue</span>
        </button>
        <button
          onClick={onStartFresh}
          disabled={isScanning}
          className="bg-transparent hover:bg-amber-500/10 border border-amber-500/30 text-amber-300/80 px-2.5 py-1 rounded font-bold uppercase tracking-wider text-[10px] flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          title={isScanning ? "Scan already in progress…" : "Delete the checkpoint and start a fresh scan"}
        >
          <RotateCcw size={11} />
          <span>Start fresh</span>
        </button>
      </div>
    </div>
  );
}
