"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Download,
  GitBranch,
  Hash,
  Save,
  User,
  X,
  Zap,
} from "lucide-react";
import type { PullRequest } from "../../../lib/types";
import { canForceRescan } from "../../../lib/forceRescan";
import { buildPrWorkspaceHeaderModel } from "../../../lib/prWorkspaceHeader";
import type { ReviewLimits } from "../../../lib/prSizeConfig";
import type { SeamChipInput } from "../../../lib/seamChips";
import type { ScanTerminalOutcome } from "../../../lib/scanTerminalOutcome";
import FailedScanBanner from "./FailedScanBanner";
import IndexNowBanner from "./IndexNowBanner";
import InterruptedScanBanner, { type InterruptedScan } from "./InterruptedScanBanner";
import LayoutCChips from "./LayoutCChips";

interface ScanResult {
  count: number;
  model: string;
  notice?: string | null;
  /** When true / failed outcome, show Failed banner instead of completed. */
  failed?: boolean;
  terminalOutcome?: Pick<
    ScanTerminalOutcome,
    "class" | "reason" | "reasonKind" | "systemWarn" | "primaryCta" | "label" | "isFailed"
  > | null;
}

interface ScanSettingsSummary {
  maxIterations: number;
  primaryModel: string | null;
  fallbackModel: string | null;
  limits: ReviewLimits;
}

export interface PrHeaderProps {
  activePR: PullRequest | undefined;
  isScanning: boolean;
  onTriggerScan: (opts?: { force?: boolean }) => void;
  onStopScan?: () => void;
  onExportMarkdown: (format: "file" | "download") => void;
  exportStatus: { kind: "file" | "download"; success: boolean; message: string } | null;
  hasFindings: boolean;
  scanResult: ScanResult | null;
  onDismissScanResult: () => void;
  reviewRun?: {
    id: string;
    status?: string;
    outcome?: string | null;
    rating?: number | null;
    completedAt?: string | null;
    reliability?: string | null;
    refused?: boolean | null;
    terminalClass?: string | null;
    systemWarn?: string | null;
  } | null;
  terminalOutcome?: ScanTerminalOutcome | null;
  repoId?: string;
  repoIndexedAt?: string | null;
  onIndexComplete?: () => void;
  interruptedScan?: InterruptedScan | null;
  onContinueScan?: (prId: string) => void;
  onStartFreshScan?: (prId: string) => void;
  queueJob?: { jobId: string; state: string; queuePosition: number | null } | null;
  mergeReady?: boolean | null;
  mergeReadyMessage?: string | null;
  blockedGate?: string | null;
  seamInput?: SeamChipInput | null;
  stale?: boolean | null;
  staleReason?: "tip_mismatch" | "diff_changed" | null;
}

export default function PrHeader({
  activePR,
  isScanning,
  onTriggerScan,
  onStopScan,
  onExportMarkdown,
  exportStatus,
  hasFindings,
  scanResult,
  onDismissScanResult,
  reviewRun,
  terminalOutcome,
  repoId,
  repoIndexedAt,
  onIndexComplete,
  interruptedScan,
  onContinueScan,
  onStartFreshScan,
  queueJob,
  blockedGate,
  seamInput,
  stale,
  staleReason,
}: PrHeaderProps) {
  const scanSettings = useScanSettingsSummary();
  const scanning = isScanning || activePR?.status === "In Progress";
  const queued = queueJob?.state === "queued";
  const liveFail = scanResult?.failed || scanResult?.terminalOutcome?.isFailed;
  const failed =
    liveFail ||
    reviewRun?.status === "failed" ||
    terminalOutcome?.isFailed === true ||
    (!!reviewRun &&
      reviewRun.status === "completed" &&
      reviewRun.rating == null &&
      reviewRun.outcome !== "skipped");
  const skipped = reviewRun?.outcome === "skipped";
  const [descExpanded, setDescExpanded] = useState(false);

  if (!activePR) {
    return (
      <div className="h-64 flex flex-col items-center justify-center border border-white/10 border-dashed rounded-xl bg-slate-900/10 p-6 text-slate-500">
        <GitBranch size={32} className="text-slate-700 animate-pulse mb-2" />
        <p className="text-sm font-semibold font-mono">No Active Branch / PR selected</p>
        <p className="text-xs text-slate-500 font-mono max-w-sm text-center mt-1">
          Select a workspace target from the sidebar menu to populate git branches and start AI security code audits.
        </p>
      </div>
    );
  }

  // Rating must come from the review run / seam only. Falling back to
  // activePR.rating via ?? would revive a prior score when the current run
  // has an explicit null rating (failed/skipped) and can false-green merge.
  const resolvedSeam: SeamChipInput = {
    ...(seamInput ?? {}),
    indexedAt: seamInput?.indexedAt ?? repoIndexedAt,
    runStatus: queued
      ? "queued"
      : scanning
        ? "in_progress"
        : (seamInput?.runStatus ?? reviewRun?.status),
    runOutcome: seamInput?.runOutcome ?? reviewRun?.outcome,
    reliability: seamInput?.reliability ?? reviewRun?.reliability,
    rating: seamInput?.rating ?? reviewRun?.rating ?? null,
    refused: seamInput?.refused ?? reviewRun?.refused,
    stale: seamInput?.stale ?? stale,
    staleReason: seamInput?.staleReason ?? staleReason ?? null,
    blockedGate: seamInput?.blockedGate ?? blockedGate,
  };

  const model = buildPrWorkspaceHeaderModel({
    title: activePR.title,
    sourceBranch: activePR.sourceBranch,
    githubPrNumber: activePR.githubPrNumber,
    status: activePR.status,
    sizeTier: activePR.sizeProfile?.tier ?? null,
    seam: resolvedSeam,
    rating: resolvedSeam.rating,
    queueState: queueJob?.state ?? null,
    queuePosition: queueJob?.queuePosition ?? null,
    blockedGate: resolvedSeam.blockedGate,
    stale: resolvedSeam.stale,
    staleReason: resolvedSeam.staleReason,
  });

  const { chips, identity, cloneFailed } = model;
  const runDisabled = cloneFailed || scanning || !repoIndexedAt;

  const runTitle = cloneFailed
    ? "Disabled while clone is failed — fix the repo checkout first."
    : !repoIndexedAt
      ? "Index the codebase first — reviews without an index produce only diff-only guesses."
      : scanning
        ? "Review already in progress."
        : failed
          ? "Last scan failed — re-run when ready."
          : skipped
            ? "Last scan skipped — no code changes were detected. Make a code change and re-run."
            : "Queue a full PR review scan now.";

  const forceTitle = cloneFailed
    ? "Disabled while clone is failed."
    : "Force re-scan: clear locks, bypass cache, and admit a fresh queue job. Always available after complete, null-rating, failed, or stuck runs.";

  const btnBase =
    "h-8 px-3 text-[11px] font-bold rounded-md inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap self-start transition-all select-none";

  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden group shrink-0 space-y-3">
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

      <div className="space-y-2 min-w-0">
        <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">
          Active pull request
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <LayoutCChips chips={chips} />

          <div className="flex gap-1.5 shrink-0 self-start flex-wrap">
            <button
              type="button"
              disabled={runDisabled}
              onClick={() => onTriggerScan()}
              title={runTitle}
              className={`${btnBase} ${
                cloneFailed || !repoIndexedAt
                  ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                  : failed && !scanning
                    ? "bg-rose-500 hover:bg-rose-400 text-black cursor-pointer"
                    : skipped && !scanning
                      ? "bg-amber-500 hover:bg-amber-400 text-black cursor-pointer"
                      : "bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-black cursor-pointer"
              } ${scanning ? "animate-pulse opacity-50" : ""}`}
            >
              <Zap size={12} className={cloneFailed || !repoIndexedAt ? "" : "fill-black"} />
                  <span>
                {scanning
                  ? "Review Running..."
                  : cloneFailed
                    ? "Clone required"
                    : !repoIndexedAt
                      ? "Index Required"
                      : failed
                        ? "Re-scan"
                        : skipped
                          ? "Skipped — re-scan"
                          : "Run PR Review"}
              </span>
            </button>

            {scanning && (
              <button
                type="button"
                onClick={() => onStopScan?.()}
                title="Stop the currently running scan without starting a replacement."
                className={`${btnBase} bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 cursor-pointer`}
              >
                <X size={12} />
                Stop
              </button>
            )}

            {canForceRescan({
              hasSelectedPr: !!activePR,
              // Visibility follows index gate only; clone failure disables
              // the control in-place so the tooltip still explains why.
              repoReviewable: !!repoIndexedAt,
            }) && (
              <button
                type="button"
                disabled={cloneFailed}
                onClick={() => onTriggerScan({ force: true })}
                title={forceTitle}
                className={`${btnBase} font-mono ${
                  cloneFailed
                    ? "bg-slate-800/50 border border-slate-700 text-slate-600 cursor-not-allowed"
                    : "bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                }`}
              >
                <AlertTriangle size={12} />
                {scanning ? "Force Restart" : "Force re-scan"}
              </button>
            )}

            {hasFindings && (
              <>
                <button
                  type="button"
                  onClick={() => onExportMarkdown("file")}
                  className={`${btnBase} bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 cursor-pointer`}
                  title="Save the markdown summary to .dragnet/reviews/<branch>/<runId>.md inside the project"
                >
                  <Save size={12} />
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => onExportMarkdown("download")}
                  className={`${btnBase} bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 cursor-pointer`}
                  title="Download the markdown summary as a .md file"
                >
                  <Download size={12} />
                  Download
                </button>
                {exportStatus && (
                  <span
                    className={`text-[10px] font-mono px-2 py-1 rounded border self-center ${
                      exportStatus.success
                        ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        : "text-rose-400 bg-rose-500/10 border-rose-500/20"
                    }`}
                  >
                    {exportStatus.message}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="pt-3 border-t border-white/5 space-y-1 min-w-0 font-mono text-sm leading-snug">
        <div className="text-white font-bold">
          <span className="text-slate-500 font-semibold">GitHub PR:</span>{" "}
          {identity.githubPrNumber != null ? (
            <>
              <span className="text-cyan-400">#{identity.githubPrNumber}</span>
              <span className="text-slate-500"> — </span>
            </>
          ) : null}
          <span>{identity.title}</span>
        </div>
        {identity.issueLine != null && identity.ticketNumber != null ? (
          <div className="text-slate-300 font-semibold">
            <span className="text-slate-500">GitHub Issue:</span>{" "}
            <span className="text-cyan-300/90">#{identity.ticketNumber}</span>
            <span className="text-slate-500"> — </span>
            <span className="text-slate-400" title={activePR.sourceBranch}>
              {activePR.sourceBranch}
            </span>
          </div>
        ) : identity.branchFallback ? (
          <div className="text-[11px] text-slate-500 truncate" title={identity.branchFallback}>
            {identity.branchFallback}
          </div>
        ) : null}
        <PrDescription
          text={activePR.description || "No description provided."}
          expanded={descExpanded}
          onToggle={() => setDescExpanded((v) => !v)}
        />
      </div>

      <IndexNowBanner
        repoId={repoId}
        indexedAt={repoIndexedAt}
        onIndexComplete={onIndexComplete}
      />

      {interruptedScan && activePR && onContinueScan && onStartFreshScan && (
        <InterruptedScanBanner
          scan={interruptedScan}
          isScanning={isScanning}
          onContinue={() => onContinueScan(activePR.id)}
          onStartFresh={() => onStartFreshScan(activePR.id)}
        />
      )}

      {!interruptedScan && failed && !scanning && (
        <FailedScanBanner
          outcome={
            scanResult?.terminalOutcome ??
            terminalOutcome ?? {
              class: "hard_fail",
              label: "Failed",
              reason:
                reviewRun?.systemWarn ||
                scanResult?.notice ||
                "Last scan did not produce an earned AI verdict.",
              reasonKind: "unknown",
              systemWarn: reviewRun?.systemWarn || scanResult?.notice || null,
              primaryCta: "rescan",
            }
          }
          isScanning={isScanning}
          onRescan={() => onTriggerScan()}
          onForceRescan={() => onTriggerScan({ force: true })}
          forceAvailable={!!repoIndexedAt && !cloneFailed}
        />
      )}

      <ScanSettingsStrip settings={scanSettings} />

      {scanResult && !scanResult.failed && !scanResult.terminalOutcome?.isFailed && (
        <div className="p-2 bg-cyan-950/20 border border-cyan-800/30 rounded text-xs text-cyan-400 font-mono flex items-center justify-between">
          <span>
            ✓ Scan run completed: Discovered <strong className="text-emerald-400">{scanResult.count}</strong> alerts using{" "}
            <strong>{scanResult.model}</strong>.
          </span>
          <button onClick={onDismissScanResult} className="hover:text-white p-0.5" aria-label="Dismiss scan result">
            <X size={12} />
          </button>
        </div>
      )}

      {scanResult?.notice && !scanResult.failed && !scanResult.terminalOutcome?.isFailed && (
        <div className="p-2 bg-amber-950/30 border border-amber-800/30 rounded text-xs text-amber-400 font-mono flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{scanResult.notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-3 border-t border-white/5 text-[11px] font-mono text-slate-500">
        <div className="flex items-center gap-1.5">
          <User size={12} className="text-slate-600" />
          <span>
            Author: <strong className="text-slate-300 font-semibold">{activePR.author}</strong>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Hash size={12} className="text-slate-600" />
          <span>
            Commit SHA: <strong className="text-slate-300 font-semibold">{activePR.commitHash}</strong>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Calendar size={12} className="text-slate-600" />
          <span>
            Detected: <strong className="text-slate-300 font-semibold">{new Date(activePR.createdAt).toLocaleDateString()}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function PrDescription({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const long = text.length > 220 || text.split("\n").length > 3;
  return (
    <div className="mt-1 max-w-3xl">
      <p
        className={
          expanded || !long
            ? "text-xs text-slate-400 italic font-mono whitespace-pre-wrap break-words"
            : "text-xs text-slate-400 italic font-mono break-words overflow-hidden max-h-14"
        }
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-1 text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-400/90 hover:text-cyan-300"
        >
          {expanded ? "Show less" : "Show full description"}
        </button>
      )}
    </div>
  );
}

function useScanSettingsSummary(): ScanSettingsSummary | null {
  const [settings, setSettings] = useState<ScanSettingsSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [limitsRes, presetsRes] = await Promise.all([
          fetch("/api/llm/review-limits"),
          fetch("/api/llm/presets"),
        ]);
        if (!limitsRes.ok || !presetsRes.ok) return;
        const [limitsData, presetsData] = await Promise.all([
          limitsRes.json(),
          presetsRes.json(),
        ]);
        const limits = limitsData.limits as ReviewLimits | undefined;
        if (!limits) return;
        const presets = Array.isArray(presetsData.presets) ? presetsData.presets : [];
        const primaryId = presetsData.primaryChatPresetId ?? presetsData.activeChatPresetId;
        const fallbackId = presetsData.fallbackChatPresetId;
        const primary = presets.find((p: { id?: string; maxIterations?: number; chatModel?: string }) => p.id === primaryId) as
          | { maxIterations?: number; chatModel?: string }
          | undefined;
        const fallback = presets.find((p: { id?: string; chatModel?: string }) => p.id === fallbackId) as
          | { chatModel?: string }
          | undefined;
        if (!cancelled) {
          setSettings({
            maxIterations: typeof primary?.maxIterations === "number" ? primary.maxIterations : 16,
            primaryModel: primary?.chatModel || null,
            fallbackModel: fallback?.chatModel || null,
            limits,
          });
        }
      } catch (err) {
        console.error("Failed loading scan settings summary:", err);
      }
    };
    load();
    window.addEventListener("dragnet:review-limits-changed", load);
    window.addEventListener("dragnet:llm-presets-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("dragnet:review-limits-changed", load);
      window.removeEventListener("dragnet:llm-presets-changed", load);
    };
  }, []);

  return settings;
}

function ScanSettingsStrip({ settings }: { settings: ScanSettingsSummary | null }) {
  if (!settings) return null;
  const { limits } = settings;
  const modelText = settings.primaryModel
    ? settings.fallbackModel
      ? `${settings.primaryModel} -> ${settings.fallbackModel}`
      : settings.primaryModel
    : "No chat model";

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3 text-[10px] font-mono text-slate-500">
      <span className="uppercase tracking-wider text-slate-600">Next scan</span>
      <ScanSettingPill label="Model" value={modelText} />
      <ScanSettingPill label="Iterations" value={String(settings.maxIterations)} />
      <ScanSettingPill label="Lines/chunk" value={`${Math.max(limits.chunkLineCap, limits.normalMaxLines).toLocaleString()} (raw: ${limits.chunkLineCap.toLocaleString()})`} />
      <ScanSettingPill label="Normal" value={`${limits.normalMaxLines.toLocaleString()} lines / ${limits.normalMaxCodeFiles} files`} />
      <ScanSettingPill label="Oversized" value={`${limits.oversizedLines.toLocaleString()} lines / ${limits.oversizedCodeFiles} files`} />
      <ScanSettingPill label="File cap" value={limits.maxFilesPerReview > 0 ? String(limits.maxFilesPerReview) : "off"} />
    </div>
  );
}

function ScanSettingPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-white/10 bg-slate-950/40 px-2 py-1">
      <span className="uppercase text-slate-600">{label}</span>
      <strong className="font-semibold text-slate-300 truncate">{value}</strong>
    </span>
  );
}
