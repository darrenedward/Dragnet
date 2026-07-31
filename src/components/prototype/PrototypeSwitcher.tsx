"use client";

import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** PROTOTYPE ONLY — floating variant switcher. Do not ship. */
export default function PrototypeSwitcher({
  variants,
  labels,
}: {
  variants: string[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get("variant") ?? variants[0] ?? "A";
  const idx = Math.max(0, variants.indexOf(current));

  const go = useCallback(
    (key: string) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set("variant", key);
      router.replace(`${pathname}?${sp.toString()}`);
    },
    [pathname, router, searchParams],
  );

  const prev = () => go(variants[(idx - 1 + variants.length) % variants.length]!);
  const next = () => go(variants[(idx + 1) % variants.length]!);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 flex items-center gap-3 rounded-full border border-white/20 bg-black/90 px-4 py-2 shadow-2xl backdrop-blur">
      <button
        type="button"
        onClick={prev}
        className="font-mono text-sm text-white hover:text-cyan-300 px-2"
        aria-label="Previous variant"
      >
        ←
      </button>
      <span className="font-mono text-[11px] text-cyan-300 min-w-[200px] text-center">
        {current} — {labels[current] ?? "variant"}
      </span>
      <button
        type="button"
        onClick={next}
        className="font-mono text-sm text-white hover:text-cyan-300 px-2"
        aria-label="Next variant"
      >
        →
      </button>
    </div>
  );
}
