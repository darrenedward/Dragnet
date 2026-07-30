"use client";

/**
 * PROTOTYPE — throwaway.
 * Sidebar: one repo per row; PR status = pending|queued|completed.
 * Main chips: size · webhook · cloned · indexed · rating (color rules).
 * ?variant=A|B|C
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import PrototypeSwitcher from "@/src/components/prototype/PrototypeSwitcher";
import { PrototypeDashboard } from "@/src/components/prototype/prHeaderVariants";

const VARIANTS = ["A", "B", "C"] as const;
const LABELS: Record<string, string> = {
  A: "status + chips",
  B: "chips only",
  C: "status card",
};

function PrototypeBody() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("variant") ?? "A";
  const variant = (raw.split("|")[0] ?? "A").toUpperCase().slice(0, 1);
  const key = (VARIANTS.includes(variant as (typeof VARIANTS)[number]) ? variant : "A") as
    | "A"
    | "B"
    | "C";

  return (
    <div className="min-h-screen bg-[#090C12] text-white p-4 sm:p-6 pb-28">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400/90">
            Prototype — throwaway · not production
          </p>
          <h1 className="text-xl font-bold tracking-tight">Sidebar + main chips</h1>
          <ul className="text-xs text-slate-400 font-mono max-w-3xl space-y-1 list-disc pl-4">
            <li>
              <strong className="text-slate-300">Repos</strong> — one row each (scrolls for 30+);
              PR shows only pending / queued / completed
            </li>
            <li>
              <strong className="text-slate-300">Main chips</strong> — size (small green · medium
              amber · oversized red), webhook / cloned / indexed (red|green), rating (1–5 red · 5–7
              amber · 8–10 green)
            </li>
          </ul>
        </header>

        <PrototypeDashboard variant={key} />
      </div>

      <PrototypeSwitcher variants={[...VARIANTS]} labels={LABELS} />
    </div>
  );
}

export default function PrHeaderPrototypePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#090C12] text-slate-400 font-mono text-sm p-8">
          Loading prototype…
        </div>
      }
    >
      <PrototypeBody />
    </Suspense>
  );
}
