"use client";

import { DollarSign } from "lucide-react";

export interface ProviderCostInfo {
  name: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  outcome: string;
  iterationsUsed: number;
  maxIterations: number;
}

export interface CostBannerData {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  providers: ProviderCostInfo[];
}

interface Props {
  tokensUsed: CostBannerData | null;
}

export function formatCost(costUsd: number): string {
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.0001) return "< $0.0001";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function outcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    success: "Success",
    quality_failure: "Quality fail",
    transport_failure: "Transport fail",
    interrupted: "Interrupted",
    unknown_failure: "Unknown fail",
  };
  return labels[outcome] ?? outcome;
}

export function outcomeColor(outcome: string): string {
  const colors: Record<string, string> = {
    success: "text-emerald-400",
    quality_failure: "text-amber-400",
    transport_failure: "text-rose-400",
    interrupted: "text-slate-400",
    unknown_failure: "text-rose-400",
  };
  return colors[outcome] ?? "text-slate-400";
}

export default function CostBanner({ tokensUsed }: Props) {
  if (!tokensUsed) {
    return (
      <div className="text-[11px] font-mono text-slate-500 flex items-center gap-1.5">
        <DollarSign size={12} className="text-slate-600" />
        <span>Cost: <span className="text-slate-400">not tracked</span></span>
      </div>
    );
  }

  const { totalCostUsd, totalPromptTokens, totalCompletionTokens, providers } = tokensUsed;

  return (
    <div
      className="text-[11px] font-mono text-slate-500"
      title={
        providers.length > 1 || providers.length === 1
          ? providers
              .map(
                (p) =>
                  `${p.name}/${p.model}: ${formatCost(p.costUsd)}, ${p.promptTokens}+${p.completionTokens} tokens, ${outcomeLabel(p.outcome)} (${p.iterationsUsed}/${p.maxIterations} iters)`,
              )
              .join(" · ")
          : undefined
      }
    >
      <div className="flex items-center gap-1.5">
        <DollarSign size={12} className="text-slate-600" />
        <span>
          Cost: <strong className="text-slate-300">{formatCost(totalCostUsd)}</strong>
          {providers.length > 1 && (
            <span className="text-slate-600"> ({providers.length} providers)</span>
          )}
          {totalPromptTokens + totalCompletionTokens > 0 && (
            <span className="text-slate-600 ml-1">
              · {(totalPromptTokens + totalCompletionTokens).toLocaleString()} tokens
            </span>
          )}
        </span>
      </div>
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 ml-5">
          {providers.map((p, i) => (
            <span
              key={i}
              className="text-[10px] text-slate-500 truncate max-w-[200px]"
              title={`${p.name}/${p.model}: ${formatCost(p.costUsd)}, ${p.promptTokens}+${p.completionTokens} tokens, ${outcomeLabel(p.outcome)} (${p.iterationsUsed}/${p.maxIterations} iterations)`}
            >
              <span className={`${outcomeColor(p.outcome)} mr-0.5`}>●</span>
              {p.name}: {formatCost(p.costUsd)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
