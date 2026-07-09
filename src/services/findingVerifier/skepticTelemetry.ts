/**
 * Skeptic pass telemetry types + helpers.
 *
 * Lives apart from `skepticPass.ts` so that file stays under the 500-line
 * budget. The telemetry shape is also consumed by `reviewService.ts`
 * (persisted into `ReviewRun.tokensUsed.skeptic`), the cost banner
 * (renders the per-provider outcome chip), and `skepticStats.ts` (the
 * cross-scan reject-rate accumulator), so a single canonical home keeps
 * the import graph shallow.
 */

import type { SkepticVerdict } from "./skepticPass";

/**
 * Per-verdict outcome counts. `adjudicated` = confirmed + downgraded +
 * rejected — findings the fallback actually graded. `skipped` never
 * reached the model (filtered by gate or capped by batch). `error`
 * covers LLM error / parse failure / discarded verdicts.
 */
export interface SkepticOutcomeCounts {
  confirmed: number;
  downgraded: number;
  rejected: number;
  skipped: number;
  error: number;
}

/**
 * Aggregated call outcome for the skeptic pass. Drives the
 * `tokensUsed.providers[].outcome` entry so the existing per-provider
 * tracking surface (CostBanner chip + tooltip) renders skeptic calls
 * alongside primary chat attempts.
 *
 *   `skeptic_skipped`   gate filtered everything, no LLM call made
 *   `skeptic_error`     LLM call threw, returned unparseable JSON, or
 *                       every verdict was discarded
 *   `skeptic_reject`    call succeeded and rejects dominated (>= any other)
 *   `skeptic_downgrade` call succeeded and downgrades dominated
 *   `skeptic_confirm`   call succeeded and confirms dominated
 */
export type SkepticCallOutcome =
  | "skeptic_confirm"
  | "skeptic_downgrade"
  | "skeptic_reject"
  | "skeptic_skipped"
  | "skeptic_error";

export interface SkepticTelemetry {
  /** Breaker key for the fallback model ({provider_host}:{model}). */
  providerKey: string;
  /** Display name of the fallback preset. */
  providerName: string;
  endpoint: string;
  model: string;
  /** Token usage from the single batched call. 0 on skip/error. */
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** Per-verdict outcome counts. */
  outcomes: SkepticOutcomeCounts;
  /** Aggregated call outcome for per-provider tracking. */
  outcome: SkepticCallOutcome;
}

export interface SkepticPassResult {
  verdicts: Map<string, SkepticVerdict>;
  telemetry: SkepticTelemetry;
}

/**
 * Pick the aggregated call outcome from per-verdict counts. The pass ran
 * the LLM successfully; we surface the dominant verdict kind so the
 * per-provider tracking (CostBanner chip) renders a representative
 * label. Ties break toward the more actionable outcome (reject before
 * downgrade before confirm) so a split-decision scan is surfaced as
 * "skeptic flagged something" rather than "all clear".
 */
export function pickCallOutcome(o: SkepticOutcomeCounts): SkepticCallOutcome {
  if (o.rejected >= o.downgraded && o.rejected >= o.confirmed && o.rejected > 0) {
    return "skeptic_reject";
  }
  if (o.downgraded >= o.confirmed && o.downgraded > 0) {
    return "skeptic_downgrade";
  }
  if (o.confirmed > 0) return "skeptic_confirm";
  // LLM returned parseable JSON but every verdict was discarded.
  return "skeptic_error";
}
