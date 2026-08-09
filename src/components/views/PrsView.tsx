"use client";

import { type ReactNode } from "react";
import { motion } from "motion/react";
import { FileCode2 } from "lucide-react";
import type { PRFile, PullRequest, ReviewChunk, ReviewFinding } from "../../lib/types";
import type { SeamChipInput } from "../../lib/seamChips";
import type { StabilityProp } from "../../lib/stabilityScore";
import ReviewProgress from "./prs/ReviewProgress";
import ReviewCard from "./prs/ReviewCard";
import BugFixFeed from "./prs/BugFixFeed";
import ScanHistory from "./prs/ScanHistory";
import type { ScanTerminalOutcome } from "../../lib/scanTerminalOutcome";
import PrHeader from "./prs/PrHeader";
import type { InterruptedScan } from "./prs/InterruptedScanBanner";

interface ScanResult {
  count: number;
  model: string;
  notice?: string | null;
  failed?: boolean;
  terminalOutcome?: Pick<
    ScanTerminalOutcome,
    "class" | "label" | "reason" | "reasonKind" | "systemWarn" | "primaryCta" | "isFailed"
  > | null;
}

interface Props {
  activePR: PullRequest | undefined;
  isScanning: boolean;
  onTriggerScan: (opts?: { force?: boolean }) => void;
  onStopScan?: () => void;
  onExportMarkdown: (format: "file" | "download") => void;
  exportStatus: { kind: "file" | "download"; success: boolean; message: string } | null;
  scanResult: ScanResult | null;
  onDismissScanResult: () => void;
  findings: ReviewFinding[];
  reviewRun?: {
    id: string;
    commitHash: string;
    diffHash: string;
    completedAt: string | null;
    rating: number | null;
    model: string | null;
    triggerReason: string | null;
    reliability?: string | null;
    refused?: boolean | null;
    status?: string;
    outcome?: string | null;
    terminalClass?: string | null;
    systemWarn?: string | null;
    chunksTotal?: number;
    chunksCompleted?: number;
    chunksFailed?: number;
    chunksSkipped?: number;
    chunksIncomplete?: number;
    lastActivityAt?: string | null;
    lastCheckpointAt?: string | null;
    heartbeatAgeMs?: number | null;
    recoveryReason?: string | null;
    tokensUsed?: {
      totalCostUsd: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      providers: Array<{
        name: string;
        model: string;
        promptTokens: number;
        completionTokens: number;
        costUsd: number;
        outcome: string;
        iterationsUsed: number;
        maxIterations: number;
      }>;
    } | null;
  } | null;
  stability?: StabilityProp | null;
  chunks?: ReviewChunk[];
  activeScan?: {
    id: string;
    commitHash: string;
    diffHash: string;
    startedAt: string;
    triggerReason: string | null;
    model: string | null;
    chunksTotal?: number;
    chunksCompleted?: number;
    chunksFailed?: number;
    chunksSkipped?: number;
    chunksIncomplete?: number;
    heartbeatAgeMs?: number;
    recoveryReason?: string | null;
  } | null;
  queueJob?: {
    jobId: string;
    state: string;
    queuePosition: number | null;
  } | null;
  activeChunks?: ReviewChunk[];
  activeFindings?: ReviewFinding[];
  activeIterations?: Record<string, { current: number; max: number }>;
  isRetryingChunks?: boolean;
  onRetryFailedChunks?: () => void;
  rejectedCount?: number;
  rejectedFindings?: Array<{
    id: string; filename: string; line: number | null;
    severity: string; category: string; explanation: string;
    verificationStatus: string | null;
    verificationNote: string | null;
    skepticVerdict: string | null;
    skepticNote: string | null;
    source: string | null;
  }>;
  stale?: boolean;
  staleReason?: "tip_mismatch" | "diff_changed" | "incomplete_chunks" | "toolchain_changed" | null;
  /** Shared merge gate from findings payload — not the same as status Completed. */
  mergeReady?: boolean | null;
  mergeBlockReason?: string | null;
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
  prFiles: PRFile[];
  selectedFilename: string;
  onSelectFilename: (name: string) => void;
  activeFile: PRFile | undefined;
  repoIndexedAt?: string | null;
  repoId?: string;
  onIndexComplete?: () => void;
  interruptedScan?: InterruptedScan | null;
  onContinueScan?: (prId: string) => void;
  onStartFreshScan?: (prId: string) => void;
  mergeReadyMessage?: string | null;
  blockedGate?: string | null;
  /** Optional repo/pipeline fields for glanceable seam chips. */
  seamInput?: SeamChipInput | null;
  /** Shared scan terminal outcome (issue #140). */
  terminalOutcome?: ScanTerminalOutcome | null;
}

export default function PrsView({
  activePR,
  isScanning,
  onTriggerScan,
  onStopScan,
  onExportMarkdown,
  exportStatus,
  scanResult,
  onDismissScanResult,
  findings,
  reviewRun,
  stability,
  chunks,
  activeScan,
  queueJob,
  activeChunks,
  activeFindings,
  activeIterations,
  isRetryingChunks,
  onRetryFailedChunks,
  rejectedCount,
  rejectedFindings,
  stale,
  staleReason,
  mergeReady,
  mergeReadyMessage,
  blockedGate,
  terminalOutcome,
  onCopySuggestion,
  copyFeedback,
  prFiles,
  selectedFilename,
  onSelectFilename,
  activeFile,
  repoIndexedAt,
  repoId,
  onIndexComplete,
  interruptedScan,
  onContinueScan,
  onStartFreshScan,
  seamInput,
}: Props) {
  return (
    <motion.div
      key="pr-scanner-viewport"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1 }}
      className="flex-1 flex flex-col xl:flex-row gap-5 overflow-hidden min-h-0"
    >
      <div className="flex flex-col min-w-0 flex-1 min-h-0">
        <PrHeader
          key={activePR?.id ?? "none"}
          activePR={activePR}
          isScanning={isScanning}
          onTriggerScan={onTriggerScan}
          onStopScan={onStopScan}
          onExportMarkdown={onExportMarkdown}
          exportStatus={exportStatus}
          hasFindings={findings.length > 0}
          scanResult={scanResult}
          onDismissScanResult={onDismissScanResult}
          reviewRun={reviewRun}
          terminalOutcome={terminalOutcome ?? null}
          repoId={repoId}
          repoIndexedAt={repoIndexedAt}
          onIndexComplete={onIndexComplete}
          interruptedScan={interruptedScan}
          onContinueScan={onContinueScan}
          onStartFreshScan={onStartFreshScan}
          queueJob={queueJob}
          mergeReady={mergeReady}
          mergeReadyMessage={mergeReadyMessage}
          blockedGate={blockedGate}
          seamInput={seamInput}
          stale={stale}
          staleReason={staleReason}
        />

        <div className="space-y-4 min-w-0 mt-4 flex-1 overflow-y-auto overflow-x-hidden min-h-0 pr-1">
          <SectionLabel>Scan Logs</SectionLabel>
          <ReviewProgress
            prId={activePR?.id}
            reviewRunId={isScanning && activeScan?.id ? activeScan.id : reviewRun?.id}
            isScanning={isScanning}
          />

          {activePR && (
            <>
              <SectionLabel>Scan Results</SectionLabel>
              <ReviewCard
                activePR={activePR}
                findings={findings}
                reviewRun={reviewRun}
                stability={stability}
                chunks={chunks}
                activeScan={activeScan}
                activeChunks={activeChunks}
                activeFindings={activeFindings}
                activeIterations={activeIterations}
                isRetryingChunks={isRetryingChunks}
                onRetryFailedChunks={onRetryFailedChunks}
                rejectedCount={rejectedCount}
                rejectedFindings={rejectedFindings}
                stale={stale}
                staleReason={staleReason}
                isScanning={isScanning}
                onCopySuggestion={onCopySuggestion}
                copyFeedback={copyFeedback}
              />
            </>
          )}

          {activePR && (
            <BugFixFeed prId={activePR.id} />
          )}

          <SectionLabel>Scan History</SectionLabel>
          <ScanHistory prId={activePR?.id} currentRunId={reviewRun?.id} />
        </div>
      </div>

      <FilesPanel
        prFiles={prFiles}
        selectedFilename={selectedFilename}
        onSelectFilename={onSelectFilename}
        activeFile={activeFile}
      />
    </motion.div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h4 className="text-[10px] font-mono font-extrabold text-slate-500 uppercase tracking-[0.2em] mt-2">
      {children}
    </h4>
  );
}

function FilesPanel({
  prFiles,
  selectedFilename,
  onSelectFilename,
  activeFile,
}: {
  prFiles: PRFile[];
  selectedFilename: string;
  onSelectFilename: (name: string) => void;
  activeFile: PRFile | undefined;
}) {
  return (
    <div className="w-full xl:w-96 shrink-0 flex flex-col gap-4 overflow-hidden min-h-0 bg-slate-950/20 border border-white/10 rounded-xl p-4">
      <div>
        <h4 className="text-[10px] font-mono font-extrabold text-slate-500 uppercase tracking-[0.2em] mb-2.5">
          Files Involved in PR
        </h4>
        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
          {prFiles.map((file) => {
            const isSelected = selectedFilename === file.filename;
            return (
              <button
                key={file.id}
                onClick={() => onSelectFilename(file.filename)}
                className={`w-full text-left p-2.5 rounded-lg border transition-all text-xs font-mono flex items-center justify-between ${
                  isSelected
                    ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-400"
                    : "border-transparent hover:bg-white/5 text-slate-400 hover:text-white"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode2 size={13} className={isSelected ? "text-cyan-400" : "text-slate-500"} />
                  <span className="truncate">{file.filename}</span>
                </div>
                <div className="flex items-center gap-1 text-[9px] font-bold shrink-0">
                  <span className="text-emerald-500">+{file.additions}</span>
                  <span className="text-rose-500">-{file.deletions}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 bg-slate-950 rounded-xl border border-white/10 overflow-hidden shadow-2xl relative">
        <div className="bg-[#090C12] py-2 px-3 border-b border-white/10 flex items-center justify-between font-mono text-[10px] text-slate-400 select-none">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-rose-500/80" />
              <div className="w-2 h-2 rounded-full bg-amber-500/80" />
              <div className="w-2 h-2 rounded-full bg-emerald-500/80" />
            </div>
            <span className="text-[11px] text-cyan-400 font-bold truncate max-w-[180px]">
              {activeFile?.filename || "Git Diff View"}
            </span>
          </div>
          <div className="text-[8px] uppercase tracking-wider font-extrabold bg-white/5 px-2 py-0.5 rounded text-slate-400 border border-white/5 shrink-0">
            RAW GIT HEADER
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-slate-300 max-h-[380px] lg:max-h-[500px] select-text">
          {activeFile ? <DiffView file={activeFile} /> : (
            <div className="h-48 flex items-center justify-center text-slate-600 italic">
              Select an involved file to inspect git patch changes.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffView({ file }: { file: PRFile }) {
  const lines = (file.diff || file.modifiedContent || "").split("\n");
  return (
    <div className="space-y-1">
      {lines.map((line, idx) => {
        const isAddition = line.startsWith("+") && !line.startsWith("+++");
        const isDeletion = line.startsWith("-") && !line.startsWith("---");
        const isHeader = line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index");
        const cls = isAddition
          ? "bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500 font-bold"
          : isDeletion
          ? "bg-rose-500/10 text-rose-400 border-l-2 border-rose-500 line-through"
          : isHeader
          ? "text-cyan-500 font-bold tracking-tight border-b border-cyan-500/5 my-1 bg-cyan-950/10"
          : "text-slate-400";
        return (
          <div key={idx} className={`py-0.5 px-1.5 rounded-sm transition-colors ${cls}`}>
            <pre className="whitespace-pre-wrap word-break break-all font-mono">{line}</pre>
          </div>
        );
      })}
    </div>
  );
}
