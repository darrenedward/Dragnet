import type { DashboardMetrics } from "../hooks/useDashboardData";

interface DashboardMetricCardsProps {
  metrics: DashboardMetrics;
}

const cards = [
  { key: "projects", label: "Projects", tone: "text-cyan-300", tint: "bg-cyan-400/10" },
  { key: "scans", label: "Scans", tone: "text-indigo-300", tint: "bg-indigo-400/10" },
  { key: "bugsFixed", label: "Bugs fixed", tone: "text-emerald-300", tint: "bg-emerald-400/10" },
] as const;

export default function DashboardMetricCards({ metrics }: DashboardMetricCardsProps) {
  return (
    <div className="hidden xl:flex items-center gap-2" aria-label="Dragnet dashboard metrics">
      <div className="flex items-center rounded-md border border-emerald-400/20 bg-[#111827] overflow-hidden" title="The Dragnet daemon is available">
        <span className="px-2 py-1 text-[9px] font-mono font-bold uppercase tracking-widest text-emerald-300 bg-emerald-400/10">Daemon</span>
        <span className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono font-bold uppercase tracking-wider text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
          Active
        </span>
      </div>
      {cards.map(({ key, label, tone, tint }) => (
        <div key={key} className="flex items-center rounded-md border border-white/10 bg-[#111827] overflow-hidden" title={`${label}: ${metrics[key]}`}>
          <span className={`px-2 py-1 text-[9px] font-mono font-bold uppercase tracking-widest ${tone} ${tint}`}>{label}</span>
          <span className="px-2 py-1 text-[11px] font-mono font-bold tabular-nums text-white">{metrics[key]}</span>
        </div>
      ))}
    </div>
  );
}
