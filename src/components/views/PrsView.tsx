"use client";

import { motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Download,
  FileCode2,
  GitBranch,
  Hash,
  Network,
  ShieldAlert,
  User,
  X,
  Zap,
} from "lucide-react";
import type { PRFile, PullRequest, ReviewFinding } from "../../lib/types";
import { getStatusBadgeStyle } from "../../lib/types";

interface ScanResult {
  count: number;
  model: string;
  notice?: string | null;
}

interface Props {
  activePR: PullRequest | undefined;
  isScanning: boolean;
  onTriggerScan: () => void;
  onExportMarkdown: () => void;
  scanResult: ScanResult | null;
  onDismissScanResult: () => void;
  findings: ReviewFinding[];
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
  prFiles: PRFile[];
  selectedFilename: string;
  onSelectFilename: (name: string) => void;
  activeFile: PRFile | undefined;
}

export default function PrsView({
  activePR,
  isScanning,
  onTriggerScan,
  onExportMarkdown,
  scanResult,
  onDismissScanResult,
  findings,
  onCopySuggestion,
  copyFeedback,
  prFiles,
  selectedFilename,
  onSelectFilename,
  activeFile,
}: Props) {
  return (
    <motion.div
      key="pr-scanner-viewport"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1 }}
      className="flex-1 flex flex-col xl:flex-row gap-5 overflow-hidden"
    >
      <div className="flex-1 flex flex-col space-y-4 overflow-y-auto min-w-0 pr-1">
        <PrHeader
          activePR={activePR}
          isScanning={isScanning}
          onTriggerScan={onTriggerScan}
          onExportMarkdown={onExportMarkdown}
          hasFindings={findings.length > 0}
          scanResult={scanResult}
          onDismissScanResult={onDismissScanResult}
        />

        {activePR && <PrStats findings={findings} />}

        {activePR && (
          <FindingsList
            findings={findings}
            onCopySuggestion={onCopySuggestion}
            copyFeedback={copyFeedback}
          />
        )}
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

function PrHeader({
  activePR,
  isScanning,
  onTriggerScan,
  onExportMarkdown,
  hasFindings,
  scanResult,
  onDismissScanResult,
}: {
  activePR: PullRequest | undefined;
  isScanning: boolean;
  onTriggerScan: () => void;
  onExportMarkdown: () => void;
  hasFindings: boolean;
  scanResult: ScanResult | null;
  onDismissScanResult: () => void;
}) {
  if (!activePR) {
    return (
      <div className="h-64 flex flex-col items-center justify-center border border-white/10 border-dashed rounded-xl bg-slate-900/10 p-6 text-slate-500">
        <GitBranch size={32} className="text-slate-700 animate-pulse mb-2" />
        <p className="text-sm font-semibold font-mono">No Active Branch / PR selected</p>
        <p className="text-xs text-slate-650 font-mono max-w-sm text-center mt-1">
          Select a workspace target from the sidebar menu to populate git branches and start AI security code audits.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden group shrink-0">
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase bg-slate-800 text-slate-450 px-2 py-0.5 rounded font-bold border border-slate-750">
              Active Pull Request View
            </span>
            <span
              className={`px-2 py-0.5 rounded uppercase font-extrabold text-[9px] font-mono flex items-center gap-1.5 shrink-0 select-none ${getStatusBadgeStyle(activePR.status)}`}
            >
              {activePR.status === "In Progress" && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              )}
              <span>{activePR.status}</span>
            </span>
            {activePR.rating !== undefined && activePR.rating !== null && (
              <span
                className={`px-2 py-0.5 rounded uppercase font-mono text-[9px] font-bold border ${
                  activePR.rating >= 9
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                    : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                }`}
              >
                PROD GRADE: {activePR.rating}/10 ({activePR.rating >= 9 ? "APPROVED" : "REJECTED"})
              </span>
            )}
          </div>
          <h3 className="text-base sm:text-lg font-bold text-white tracking-tight mt-1">{activePR.title}</h3>
          <p className="text-xs text-slate-400 italic font-mono mt-1">{activePR.description || "No description provided."}</p>
        </div>

        <div className="flex gap-2">
          <button
            disabled={isScanning}
            onClick={onTriggerScan}
            className={`px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-500 hover:from-cyan-400 hover:to-indigo-400 text-black text-xs font-bold rounded-lg flex items-center gap-1.5 transition-all shadow-md cursor-pointer select-none ${
              isScanning ? "animate-pulse opacity-50" : ""
            }`}
          >
            <Zap size={14} className="fill-black" />
            <span>{isScanning ? "AI Pipeline Working..." : "Trigger AI Review Scan"}</span>
          </button>
          {hasFindings && (
            <button
              onClick={onExportMarkdown}
              className="px-3 py-2 bg-white/5 border border-white/10 text-slate-350 hover:bg-white/10 text-xs font-mono font-bold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              title="Download complete markdown report summary"
            >
              <Download size={13} />
              <span>Export MD Card</span>
            </button>
          )}
        </div>
      </div>

      {scanResult && (
        <div className="mt-3 p-2 bg-cyan-950/20 border border-cyan-800/30 rounded text-xs text-cyan-400 font-mono flex items-center justify-between">
          <span>
            ✓ Scan run completed: Discovered <strong className="text-emerald-400">{scanResult.count}</strong> alerts using{" "}
            <strong>{scanResult.model}</strong>.
          </span>
          <button onClick={onDismissScanResult} className="hover:text-white p-0.5">
            <X size={12} />
          </button>
        </div>
      )}

      {scanResult?.notice && (
        <div className="mt-2 p-2 bg-amber-950/30 border border-amber-800/30 rounded text-xs text-amber-400 font-mono flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{scanResult.notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3.5 pt-3.5 border-t border-white/5 text-[11px] font-mono text-slate-500">
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
            Detected: <strong className="text-slate-305 font-semibold">{new Date(activePR.createdAt).toLocaleDateString()}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function PrStats({ findings }: { findings: ReviewFinding[] }) {
  const blockers = findings.filter((f) => f.severity === "blocker" || f.severity === "warning").length;
  const suggestions = findings.filter((f) => f.severity === "suggestion").length;
  return (
    <div className="p-3 bg-slate-905 border border-white/10 rounded-lg flex items-center justify-between gap-3 shrink-0">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-indigo-500/10 rounded text-indigo-400 border border-indigo-500/20">
          <Activity size={15} />
        </div>
        <div>
          <div className="text-[10px] text-slate-500 font-mono uppercase font-bold">PR Compliance Policy Status</div>
          <div className="text-xs font-semibold text-white">Metrics checklist: Section 8 (Security, Correctness, Performance)</div>
        </div>
      </div>
      <div className="flex gap-5 font-mono">
        <div className="text-center">
          <div className="text-xl font-bold text-rose-500">{blockers}</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Vulnerabilities / Warnings</div>
        </div>
        <div className="text-center">
          <div className="text-xl font-bold text-emerald-400">{suggestions}</div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Suggestions</div>
        </div>
      </div>
    </div>
  );
}

function FindingsList({
  findings,
  onCopySuggestion,
  copyFeedback,
}: {
  findings: ReviewFinding[];
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs uppercase font-mono tracking-wider font-extrabold text-slate-500 flex items-center gap-1.5 pb-1">
        <ShieldAlert size={13} className="text-rose-400 animate-pulse" />
        <span>AI Core Code Audit Findings ({findings.length})</span>
      </h4>

      {findings.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-white/5 bg-slate-950/20 text-slate-500 flex flex-col items-center justify-center">
          <CheckCircle2 size={24} className="text-emerald-400 mb-1.5" />
          <p className="text-xs font-bold text-slate-350 font-mono">Status: Ready for review scan</p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
            Click "Trigger AI Review Scan" to run real-time static checking.
          </p>
        </div>
      ) : (
        findings.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            onCopySuggestion={onCopySuggestion}
            copyFeedback={copyFeedback}
          />
        ))
      )}
    </div>
  );
}

function FindingCard({
  finding,
  onCopySuggestion,
  copyFeedback,
}: {
  finding: ReviewFinding;
  onCopySuggestion: (text: string, id: string) => void;
  copyFeedback: string | null;
}) {
  const borderClass =
    finding.severity === "blocker"
      ? "border-rose-500/25 bg-rose-500/[0.01] hover:border-rose-500/40"
      : finding.severity === "warning"
      ? "border-amber-500/25 bg-amber-500/[0.01] hover:border-amber-500/40"
      : "border-white/10 hover:border-cyan-500/30";

  const badgeClass =
    finding.severity === "blocker"
      ? "bg-rose-500/15 text-rose-400 border-rose-500/25"
      : finding.severity === "warning"
      ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
      : "bg-slate-800 text-slate-400 border-slate-750";

  const evidencePoints = parseEvidence(finding.evidenceChain);

  return (
    <div className={`bg-[#0F1219] p-4 rounded-xl border transition-all flex flex-col gap-3 relative overflow-hidden group ${borderClass}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase font-mono border ${badgeClass}`}>
            {finding.severity}
          </span>
          <span className="text-[10px] font-mono text-cyan-400 bg-cyan-400/5 px-1.5 rounded font-bold uppercase tracking-wider">
            {finding.category}
          </span>
          <span className="text-xs font-semibold text-white tracking-tight">{finding.filename}</span>
        </div>
        <span className="text-[10px] font-mono text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-white/5">
          Line {finding.line}
        </span>
      </div>

      <p className="text-xs text-slate-350 leading-relaxed font-sans mt-0.5">{finding.explanation}</p>

      {evidencePoints.length > 0 && (
        <div className="mt-1.5 text-xs font-mono bg-slate-950/50 p-3 rounded-lg border border-white/5 space-y-2">
          <div className="text-[10px] text-cyan-400 uppercase font-bold flex items-center gap-1.5 border-b border-white/5 pb-1 select-none">
            <Network size={12} className="text-cyan-400" />
            <span>Core Call-Graph Investigation Log</span>
          </div>
          <div className="space-y-2 pl-1 border-l border-cyan-500/20 ml-1.5">
            {evidencePoints.map((point, pIdx) => (
              <div key={pIdx} className="text-[11px] leading-relaxed flex items-start gap-1.5">
                <span className="text-cyan-500 font-extrabold select-none shrink-0">[{pIdx + 1}]</span>
                <span className="text-slate-400">
                  <strong className="text-slate-300">{point.file}</strong> (Line {point.line}): {point.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {finding.diffSuggestion && (
        <div className="relative">
          <div className="bg-black/50 rounded-lg p-3 font-mono text-xs text-slate-300 border border-white/5 overflow-x-auto select-all max-h-48 whitespace-pre">
            <div className="text-slate-600 text-[10px] font-semibold border-b border-white/5 pb-1 mb-2 select-none uppercase tracking-wide flex items-center justify-between">
              <span>Suggested Fix</span>
              <button
                onClick={() => onCopySuggestion(finding.diffSuggestion, finding.id)}
                className="hover:text-white transition-colors"
              >
                {copyFeedback === finding.id ? "Copied!" : "Copy Fix"}
              </button>
            </div>
            <div className="text-[11px] font-mono leading-relaxed text-slate-300">{finding.diffSuggestion}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function parseEvidence(chain: ReviewFinding["evidenceChain"]): Array<{ file: string; line: number; text: string }> {
  if (!chain) return [];
  try {
    const parsed = typeof chain === "string" ? JSON.parse(chain) : chain;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
                key={file.filename}
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
          ? "bg-rose-500/10 text-rose-350 border-l-2 border-rose-500 line-through"
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
