/**
 * Persisted `ReviewRun.tokensUsed` payload shape + builder (Phase 2 cost
 * telemetry, extended for issue #73).
 *
 * Lives outside `reviewService.ts` so that 2,400-line module stops growing
 * every time we extend telemetry. Pure data + a pure builder — no review-
 * service internals.
 *
 * Shape is intentionally flat + UI-ready: the PR review banner reads
 * `totalCostUsd` + `providers[]` directly, no joins or computation
 * needed. Per-provider breakdown lets the operator spot "NVIDIA cost
 * $0.20 to produce nothing, Minimax cost $0.02 to produce the review"
 * at a glance.
 *
 * `outcome` per provider uses the classifier vocabulary
 * (`success | quality_failure | transport_failure | interrupted |
 * unknown_failure | skeptic_*`) so the UI can pair cost with outcome.
 */

import type { OutcomeClass, ProviderAttempt } from "./failureClassifier";
import type { SkepticTelemetry } from "@/src/services/findingVerifier/skepticTelemetry";

/**
 * Persisted skeptic telemetry slice. Alias for the runtime `SkepticTelemetry`
 * shape — one source of truth, no field-by-field duplication. The skeptic
 * pass returns this; `buildTokensUsed` folds it into `TokensUsed.skeptic`
 * and into the totals.
 */
export type SkepticTokensUsed = SkepticTelemetry;

export interface TokensUsed {
  totalCostUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  providers: Array<{
    name: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    outcome: OutcomeClass;
    iterationsUsed: number;
    maxIterations: number;
  }>;
  /**
   * Skeptic pass telemetry (issue #73). Present when the fallback-model
   * adjudication pass ran this scan — null when the pass was disabled,
   * no fallback was configured, or there were no candidate findings.
   * The skeptic call's tokens are ALSO rolled into the totals above
   * (totalCostUsd, totalPromptTokens, totalCompletionTokens) and the
   * skeptic call appears once in `providers[]` so the existing chip
   * surface renders it. This field carries the per-verdict breakdown.
   */
  skeptic?: SkepticTokensUsed | null;
}

/**
 * Build the persisted payload from per-attempt records. Pure + testable.
 * Sums tokens/cost across providers; carries outcome + iteration counts
 * so the UI can render "NVIDIA ran 4/4 (quality_failure) — $0.003,
 * Minimax ran 2/8 (success) — $0.001" without re-deriving anything.
 *
 * The optional `skeptic` telemetry (issue #73) is folded into the
 * totals AND appended to `providers[]` as a synthetic attempt so the
 * CostBanner chip surface renders it. Iteration counts are 1/1 — the
 * skeptic pass is a single batched call, not an agentic loop.
 */
export function buildTokensUsed(
  attempts: ProviderAttempt[],
  skeptic?: SkepticTokensUsed | null,
): TokensUsed {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUsd = 0;
  for (const a of attempts) {
    totalPromptTokens += a.promptTokens;
    totalCompletionTokens += a.completionTokens;
    totalCostUsd += a.costUsd;
  }
  if (skeptic) {
    totalPromptTokens += skeptic.promptTokens;
    totalCompletionTokens += skeptic.completionTokens;
    totalCostUsd += skeptic.costUsd;
  }
  return {
    totalCostUsd: Math.round(totalCostUsd * 1e6) / 1e6,
    totalPromptTokens,
    totalCompletionTokens,
    providers: [
      ...attempts.map((a) => ({
        name: a.provider,
        model: a.model,
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        costUsd: a.costUsd,
        outcome: a.outcome,
        iterationsUsed: a.iterationsUsed,
        maxIterations: a.maxIterations,
      })),
      // Skeptic call renders as a pseudo-provider row so the existing
      // chip + tooltip surface picks it up. outcomeLabel/outcomeColor
      // in CostBanner know about the skeptic_* outcomes.
      ...(skeptic
        ? [{
            name: `${skeptic.providerName} (skeptic)`,
            model: skeptic.model,
            promptTokens: skeptic.promptTokens,
            completionTokens: skeptic.completionTokens,
            costUsd: skeptic.costUsd,
            outcome: skeptic.outcome,
            iterationsUsed: 1,
            maxIterations: 1,
          }]
        : []),
    ],
    skeptic: skeptic ?? null,
  };
}
