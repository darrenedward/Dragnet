"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Copy, Cpu, Loader2, Search, Siren, XCircle } from "lucide-react";
import { fetchJson } from "../../../lib/http";
import { formatScanLogText } from "../../../lib/scanLogText";

interface LogEntry {
  id: string;
  message: string;
  level: string;
  createdAt: string;
  reviewRunId?: string | null;
}

interface Props {
  prId?: string;
  reviewRunId?: string | null;
  isScanning?: boolean;
}

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  info: <Bot size={11} className="text-cyan-400" />,
  tool_call: <Search size={11} className="text-indigo-400" />,
  warn: <Siren size={11} className="text-amber-400" />,
  error: <XCircle size={11} className="text-rose-400" />,
};

const LEVEL_COLORS: Record<string, string> = {
  info: "text-cyan-300",
  tool_call: "text-indigo-300",
  warn: "text-amber-300",
  error: "text-rose-300",
};

function copyText(text: string): void {
  try {
    void navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

export default function ReviewProgress({ prId, reviewRunId, isScanning }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logSignatureRef = useRef("");
  const logCountRef = useRef(0);

  useEffect(() => {
    if (!reviewRunId) {
      setLogs([]);
      logSignatureRef.current = "";
      logCountRef.current = 0;
      return;
    }

    let cancelled = false;
    logSignatureRef.current = "";
    logCountRef.current = 0;

    const poll = async () => {
      try {
        const res = await fetchJson(`/api/reviews/log?reviewRunId=${reviewRunId}`);
        if (!cancelled && res.ok) {
          const nextLogs: LogEntry[] = await res.json();
          const signature = nextLogs.map((log) => `${log.id}:${log.level}`).join("|");
          if (signature !== logSignatureRef.current) {
            logSignatureRef.current = signature;
            setLogs(nextLogs);
          }
        }
      } catch {
        // ignore polling errors
      }
      if (cancelled) return;
      pollRef.current = setTimeout(poll, 2000);
    };

    poll();

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [reviewRunId]);

  useEffect(() => {
    if (expanded && logs.length > logCountRef.current) {
      bottomRef.current?.scrollIntoView({ block: "nearest" });
    }
    logCountRef.current = logs.length;
  }, [logs.length, expanded]);

  const handleCopyLog = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const text = formatScanLogText(logs);
      if (!text) return;
      copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [logs],
  );

  if (!reviewRunId || !prId) return null;

  return (
    <div className="mt-3 border border-white/10 rounded-lg overflow-hidden bg-slate-950/50">
      <div className="w-full px-3 py-2 bg-slate-900/60 flex items-center justify-between gap-2 text-xs font-mono select-none">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer hover:opacity-90 transition-opacity"
        >
          {isScanning ? (
            <Loader2 size={12} className="text-cyan-400 animate-spin shrink-0" />
          ) : (
            <Cpu size={12} className="text-slate-400 shrink-0" />
          )}
          <span className="text-cyan-400 font-bold uppercase tracking-wider text-[10px]">
            {isScanning ? "Review Progress" : "Last Scan Log"}
          </span>
          <span className="text-slate-500 text-[10px]">({logs.length} events)</span>
          {expanded ? (
            <ChevronDown size={14} className="text-slate-400 ml-auto shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-slate-400 ml-auto shrink-0" />
          )}
        </button>
        <button
          type="button"
          onClick={handleCopyLog}
          disabled={logs.length === 0}
          title="Copy scan log to clipboard"
          aria-label="Copy log"
          className="inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded border border-white/10 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-300 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          <Copy size={11} />
          <span>{copied ? "Copied!" : "Copy log"}</span>
        </button>
      </div>

      {expanded && (
        <div className="h-44 overflow-y-auto p-2 space-y-0.5 select-text">
          {logs.length === 0 ? (
            <div className="text-[10px] text-slate-600 font-mono text-center py-4 italic">
              Waiting for AI review loop to start...
            </div>
          ) : (
            <>
              {logs.map((log) => (
                <div key={log.id} className="flex gap-1.5 text-[10px] font-mono leading-relaxed px-1 py-0.5 rounded hover:bg-white/[0.02]">
                  <span className="shrink-0 mt-0.5 select-none">{LEVEL_ICONS[log.level] || <Cpu size={11} className="text-slate-500" />}</span>
                  <span className={`${LEVEL_COLORS[log.level] || "text-slate-300"} flex-1 min-w-0`}>{log.message}</span>
                </div>
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
