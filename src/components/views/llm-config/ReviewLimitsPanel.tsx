"use client";

import { useEffect, useState } from "react";
import { AlertCircle, RotateCcw, Save } from "lucide-react";
import type { ReviewLimits } from "../../../lib/prSizeConfig";

/**
 * Review-engine limits panel — exposes the knobs in
 * `.dragnet/review-limits.json` to the UI. Defaults match the
 * pre-config constants (chunkCap=600 etc.) so existing users see no
 * behavior change until they tune something.
 *
 * Fields are grouped by purpose:
 *  - Chunking: how big each LLM call's input is
 *  - PR-tier thresholds: when Dragnet switches to chunked mode
 *  - Tail-skip (off by default): Greptile-style file cap
 */
const DEFAULTS: ReviewLimits = {
  chunkLineCap: 600,
  minUsefulChunkLines: 100,
  normalMaxLines: 800,
  normalMaxCodeFiles: 40,
  oversizedLines: 3000,
  oversizedCodeFiles: 100,
  maxFilesPerReview: 0,
};

const BOUNDS = {
  chunkLineCap: { min: 300, max: 3000 },
  minUsefulChunkLines: { min: 50, max: 500 },
  normalMaxLines: { min: 200, max: 5000 },
  normalMaxCodeFiles: { min: 5, max: 200 },
  oversizedLines: { min: 1000, max: 20000 },
  oversizedCodeFiles: { min: 20, max: 500 },
  maxFilesPerReview: { min: 0, max: 500 },
} as const;

type FieldKey = keyof ReviewLimits;

export default function ReviewLimitsPanel() {
  const [limits, setLimits] = useState<ReviewLimits>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/llm/review-limits");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.limits) setLimits(data.limits);
        if (data.defaults) {
          // Keep DEFAULTS in sync with what the server reports.
          Object.assign(DEFAULTS, data.defaults);
        }
      } catch (err) {
        console.error("Failed loading review limits:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = (key: FieldKey, value: number) => {
    setLimits((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setClientError(null);
  };

  const validate = (next: ReviewLimits): string | null => {
    for (const key of Object.keys(next) as FieldKey[]) {
      const v = next[key];
      const { min, max } = BOUNDS[key];
      if (key === "maxFilesPerReview") {
        if (v !== 0 && (v < 20 || v > max)) {
          return `${labelFor(key)} must be 0 (off) or between 20 and ${max}.`;
        }
        continue;
      }
      if (v < min || v > max) {
        return `${labelFor(key)} must be between ${min} and ${max}.`;
      }
    }
    if (next.oversizedLines <= next.normalMaxLines) {
      return "Oversized lines must exceed Normal lines.";
    }
    if (next.oversizedCodeFiles <= next.normalMaxCodeFiles) {
      return "Oversized files must exceed Normal files.";
    }
    if (next.chunkLineCap <= next.minUsefulChunkLines) {
      return "Lines per chunk must exceed Min useful chunk.";
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate(limits);
    if (err) {
      setClientError(err);
      return;
    }
    setIsSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch("/api/llm/review-limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(limits),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSaveResult({ success: true, message: "Saved. Next scan uses the new limits." });
        setDirty(false);
        window.dispatchEvent(new Event("dragnet:review-limits-changed"));
      } else {
        setSaveResult({ success: false, message: data.error || "Save failed." });
      }
    } catch (e: any) {
      setSaveResult({ success: false, message: "Network or server error: " + e.message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setLimits({ ...DEFAULTS });
    setDirty(true);
    setClientError(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-slate-500 font-mono text-xs">
        Loading review limits...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Chunking"
        subtitle="How big each LLM call's input is. Bigger = fewer chunks but slower per call."
      >
        <NumberInput
          label="Lines per chunk"
          value={limits.chunkLineCap}
          min={BOUNDS.chunkLineCap.min}
          max={BOUNDS.chunkLineCap.max}
          onChange={(v) => updateField("chunkLineCap", v)}
        />
        <NumberInput
          label="Min useful chunk"
          value={limits.minUsefulChunkLines}
          min={BOUNDS.minUsefulChunkLines.min}
          max={BOUNDS.minUsefulChunkLines.max}
          onChange={(v) => updateField("minUsefulChunkLines", v)}
        />
      </SectionCard>

      <SectionCard
        title="PR-tier thresholds"
        subtitle="When Dragnet switches from single-shot review to chunked Large PR Mode."
      >
        <NumberInput
          label="Normal — max lines"
          value={limits.normalMaxLines}
          min={BOUNDS.normalMaxLines.min}
          max={BOUNDS.normalMaxLines.max}
          onChange={(v) => updateField("normalMaxLines", v)}
        />
        <NumberInput
          label="Normal — max code files"
          value={limits.normalMaxCodeFiles}
          min={BOUNDS.normalMaxCodeFiles.min}
          max={BOUNDS.normalMaxCodeFiles.max}
          onChange={(v) => updateField("normalMaxCodeFiles", v)}
        />
        <NumberInput
          label="Oversized — max lines"
          value={limits.oversizedLines}
          min={BOUNDS.oversizedLines.min}
          max={BOUNDS.oversizedLines.max}
          onChange={(v) => updateField("oversizedLines", v)}
        />
        <NumberInput
          label="Oversized — max code files"
          value={limits.oversizedCodeFiles}
          min={BOUNDS.oversizedCodeFiles.min}
          max={BOUNDS.oversizedCodeFiles.max}
          onChange={(v) => updateField("oversizedCodeFiles", v)}
        />
      </SectionCard>

      <SectionCard
        title="Tail-skip (Greptile-style file cap)"
        subtitle="0 = review every file. Set to 20–500 to cap how many code files reach the chunker; the largest N are kept, the rest are dropped with a warning."
      >
        <NumberInput
          label="Max files per review"
          value={limits.maxFilesPerReview}
          min={BOUNDS.maxFilesPerReview.min}
          max={BOUNDS.maxFilesPerReview.max}
          onChange={(v) => updateField("maxFilesPerReview", v)}
          helpText="0 = off (review everything). 100 = Greptile's default."
        />
      </SectionCard>

      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/5">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
        >
          {isSaving ? null : <Save size={13} />}
          <span>{isSaving ? "Saving..." : "Save Changes"}</span>
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={isSaving}
          className="border border-white/10 hover:border-white/20 text-slate-400 hover:text-white text-xs font-mono px-3 py-2 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
        >
          <RotateCcw size={12} />
          <span>Reset to defaults</span>
        </button>
        {dirty && !isSaving && (
          <span className="text-[11px] font-mono px-2 py-1 rounded border text-amber-400 bg-amber-500/10 border-amber-500/20 flex items-center gap-1">
            <AlertCircle size={10} /> Unsaved changes
          </span>
        )}
        {clientError && (
          <span className="text-[11px] font-mono px-2 py-1 rounded border text-rose-400 bg-rose-500/10 border-rose-500/20 flex items-center gap-1">
            <AlertCircle size={10} /> {clientError}
          </span>
        )}
        {saveResult && (
          <span
            className={`text-[11px] font-mono px-2 py-1 rounded border ${
              saveResult.success
                ? "text-cyan-400 bg-cyan-500/10 border-cyan-500/20"
                : "text-rose-400 bg-rose-500/10 border-rose-500/20"
            }`}
          >
            {saveResult.message}
          </span>
        )}
      </div>
    </div>
  );
}

function labelFor(key: FieldKey): string {
  switch (key) {
    case "chunkLineCap": return "Lines per chunk";
    case "minUsefulChunkLines": return "Min useful chunk";
    case "normalMaxLines": return "Normal — max lines";
    case "normalMaxCodeFiles": return "Normal — max code files";
    case "oversizedLines": return "Oversized — max lines";
    case "oversizedCodeFiles": return "Oversized — max code files";
    case "maxFilesPerReview": return "Max files per review";
  }
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5">
      <h4 className="text-[11px] font-bold font-mono text-cyan-300 uppercase tracking-wider mb-1">
        {title}
      </h4>
      <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">{subtitle}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
  helpText,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  helpText?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase font-mono text-slate-400 tracking-wider">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className="bg-slate-950/60 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-cyan-300 focus:border-cyan-500/40 focus:outline-none transition-colors"
      />
      {helpText && (
        <span className="text-[9px] text-slate-600 font-mono leading-snug">{helpText}</span>
      )}
    </label>
  );
}
