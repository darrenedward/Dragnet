"use client";

/**
 * PROTOTYPE — throwaway. Locked to layout C + hover tooltips.
 * ?variant= ignored (always C); switcher hidden.
 */

import { Suspense } from "react";
import { PrototypeDashboard } from "@/src/components/prototype/prHeaderVariants";

function PrototypeBody() {
  return (
    <div className="min-h-screen bg-[#090C12] text-white p-4 sm:p-6 pb-12">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400/90">
            Prototype — throwaway · not production · layout C
          </p>
          <h1 className="text-xl font-bold tracking-tight">PR header + sidebar</h1>
          <p className="text-xs text-slate-400 font-mono max-w-2xl">
            Hover any chip or status for a tooltip. Title block is two lines: GitHub / Issue — no
            repeated numbers.
          </p>
        </header>

        <PrototypeDashboard variant="C" />
      </div>
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
