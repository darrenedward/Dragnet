"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { CheckCircle2, Code, X } from "lucide-react";

const STORAGE_KEY = "dragnet.hideTrivialSkipNotice";

interface Props {
  open: boolean;
  lastRating: number | null;
  lastScanAt: string | null;
  onClose: () => void;
}

/**
 * Trivial-skip results popup. Triggered when runPrScan returns
 * `usedModel: "none (skipped)"` (Tier 1+2 clean + diff is all
 * config/docs/generated/lockfile). Surfaces the verdict the user
 * asked for: "we never reviewed this PR because nothing in the diff
 * was code, your last rating still stands, here is what to do next."
 *
 * The opt-out ("don't show again") persists in localStorage so users
 * who already understand the trivial-skip path can dismiss this
 * permanently per browser. Clearing site data resets it — by design.
 */
export default function TrivialSkipNotice({ open, lastRating, lastScanAt, onClose }: Props) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDontShowAgain(window.localStorage.getItem(STORAGE_KEY) === "1");
  }, [open]);

  if (!open) return null;

  const handleClose = () => {
    if (dontShowAgain && typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, "1");
    }
    onClose();
  };

  const ratingText = lastRating !== null ? `${lastRating}/10` : "no prior grade";
  const scanAge = lastScanAt ? formatRelativeShort(lastScanAt) : "before this scan";

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-[60] p-4 select-none">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-[#0F1219] border border-white/15 w-full max-w-md rounded-xl overflow-hidden shadow-2xl flex flex-col"
      >
        <div className="px-5 py-4 bg-slate-950/70 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-cyan-400" />
            <span className="text-sm font-bold text-white tracking-tight uppercase font-mono">
              Scan Results
            </span>
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-all"
            aria-label="Close trivial-skip notice"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm text-slate-300">
          <p className="leading-relaxed">
            We checked your PR and didn&rsquo;t find any changes to the <span className="text-cyan-400">code</span>.
            All the files in this diff are config, documentation, or generated/lockfile files, so the
            AI review pipeline had nothing to review.
          </p>

          <div className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2.5 text-xs font-mono">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400 uppercase tracking-wider">Latest code-review grade</span>
              <span className="text-cyan-400 font-bold">{ratingText}</span>
            </div>
            {lastScanAt && (
              <div className="mt-1 text-slate-500">
                From the last scan that touched code ({scanAge})
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 pt-1 text-xs text-slate-400">
            <Code size={13} className="shrink-0 mt-0.5 text-cyan-400" />
            <p className="leading-relaxed">
              Make a code change and re-run the review to refresh the grade, or use the existing
              <span className="text-cyan-400"> {ratingText}</span> result against the current codebase and run
              another scan once your changes are pushed.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-white/10 bg-slate-950/40 flex items-center justify-between">
          <label className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="accent-cyan-500"
            />
            <span>Don&rsquo;t show this again for trivial skips</span>
          </label>
          <button
            type="button"
            onClick={handleClose}
            className="bg-cyan-500 hover:bg-cyan-400 text-black px-4 py-1.5 rounded font-bold transition-all cursor-pointer text-xs font-mono uppercase"
          >
            Got it
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function formatRelativeShort(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaMs = Date.now() - then;
  const min = Math.round(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}
