"use client";

/**
 * PROTOTYPE — throwaway.
 * Sidebar = nav only. Main center = repo health + PR (like Diff Scanner).
 * ?variant=A|B|C
 */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import PrototypeSwitcher from "@/src/components/prototype/PrototypeSwitcher";
import { PrototypeDashboard } from "@/src/components/prototype/prHeaderVariants";

const VARIANTS = ["A", "B", "C"] as const;
const LABELS: Record<string, string> = {
  A: "Minimal PR card",
  B: "Same + notes",
  C: "Status card PR",
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
          <h1 className="text-xl font-bold tracking-tight">Main content declutter</h1>
          <div className="text-xs text-slate-400 font-mono max-w-3xl space-y-1">
            <p>
              <strong className="text-slate-300">Sidebar</strong> = minimal nav (full names, PR # ·
              ticket #, rating, status). No health/logs.
            </p>
            <p>
              <strong className="text-slate-300">Main</strong> = Cloned / Indexed / Webhook (OK/FAIL
              only — detail stays in real scan logs) + PR card.
            </p>
          </div>
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
