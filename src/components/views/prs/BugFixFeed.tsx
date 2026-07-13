"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/src/lib/http";

interface BugFixEvent {
  id: string;
  filename: string;
  line: number | null;
  category: string;
  severity: string;
  fixedAt: string;
  fixedAtScanId: string;
  originatedAtScanId: string | null;
  sourceFindingId: string | null;
  title: string | null;
}

interface BugFixResponse {
  fixedCount: number;
  events: BugFixEvent[];
  hasPriorRun: boolean;
}

interface Props {
  prId: string;
}

export default function BugFixFeed({ prId }: Props) {
  const [data, setData] = useState<BugFixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const fetchFixes = useCallback(async () => {
    try {
      const res = await fetchJson(`/api/prs/${prId}/fixes`);
      if (!res.ok) {
        setData(null);
        return;
      }
      const json: BugFixResponse = await res.json();
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [prId]);

  useEffect(() => {
    fetchFixes();
  }, [fetchFixes]);

  if (loading || !data) return null;

  if (data.fixedCount === 0 && !data.hasPriorRun) {
    return (
      <div className="mt-4 text-xs text-gray-500 dark:text-gray-400 italic">
        Awaiting next scan to detect fix events.
      </div>
    );
  }

  if (data.fixedCount === 0) {
    return null;
  }

  return (
    <div className="mt-4 border border-green-500/30 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-green-500/10 text-green-700 dark:text-green-300 text-sm font-medium hover:bg-green-500/15 transition-colors"
      >
        <span>{data.fixedCount} blocker{data.fixedCount !== 1 ? "s" : ""} fixed</span>
        <span className="text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {data.events.map((event) => (
            <div key={event.id} className="px-3 py-2 text-xs space-y-1">
              {event.title && (
                <div className="text-gray-800 dark:text-gray-100 font-medium leading-tight">
                  {event.title}
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  blocker
                </span>
                <span className="text-gray-700 dark:text-gray-200 font-medium truncate">
                  {event.filename}:{event.line ?? "?"}
                </span>
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                Fixed at scan <span className="font-mono text-[10px]">{event.fixedAtScanId.slice(0, 8)}</span>
                {" — "}
                {new Date(event.fixedAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
