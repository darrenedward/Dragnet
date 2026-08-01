/**
 * Layout-C status / rating / size pill presenters (pure).
 *
 * Shared by sidebar compact pills and header chips — no presentation fork.
 * Returns tone + label + tooltip only; UI maps tones to classes.
 *
 * Status trio: pending (amber) · processing (blue, + queue #) · completed (green).
 * Failed and other lifecycle states are explicit and never completed-green.
 *
 * Rating: 1–4 red · 5–7 amber · 8–10 green · null → "no score" amber.
 * Size visual bands: small green · medium amber · oversized red.
 * Production tier `large` collapses into the oversized (red) band.
 */

import type { PrSizeTier } from "./prSizeProfile";

/** Glanceable color language for layout-C oblong pills. */
export type LayoutCPillTone = "amber" | "blue" | "green" | "red";

/** Display kinds for the status pill (lifecycle, not merge permission). */
export type LayoutCStatusKind =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "merged";

/** Three visual size bands used by layout C (production has four tiers). */
export type LayoutCSizeBand = "small" | "medium" | "oversized";

export type LayoutCStatusPill = {
  kind: LayoutCStatusKind;
  label: string;
  tone: LayoutCPillTone;
  tooltip: string;
  queuePosition: number | null;
};

export type LayoutCRatingPill = {
  score: number | null;
  label: string;
  tone: LayoutCPillTone;
  tooltip: string;
};

export type LayoutCSizePill = {
  /** Production tier when known (large remains distinguishable in the label). */
  tier: PrSizeTier | null;
  /** Collapsed visual band for color. */
  band: LayoutCSizeBand;
  label: string;
  tone: LayoutCPillTone;
  tooltip: string;
};

export type PresentStatusPillInput = {
  /** Production PR.status (Pending | In Progress | Completed | Failed | Merged | …). */
  status: string;
  /** Active queue job state when known (queued | running | …). */
  queueState?: string | null;
  /** 1-based queue depth when known. */
  queuePosition?: number | null;
  /**
   * Optional shared terminal outcome (issue #140). When failed, overrides
   * Completed-green even if PR.status lagged. When processing/queued, keeps
   * processing. Queue wait reason surfaces in tooltip when provided.
   */
  terminalClass?: string | null;
  terminalReason?: string | null;
  /** Global concurrent scan limit for queue wait tooltip. */
  queueGlobalLimit?: number | null;
  queueRepoLimit?: number | null;
};

const ACTIVE_QUEUE = new Set(["queued", "running"]);

function normalizeQueuePosition(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

/**
 * Map production PR status + optional queue job into layout-C status pill.
 * Completed = scan finished only — not merge-ready.
 */
export function presentStatusPill(input: PresentStatusPillInput): LayoutCStatusPill {
  const status = (input.status ?? "").trim();
  const queueState = (input.queueState ?? "").trim().toLowerCase();
  const queuePosition = normalizeQueuePosition(input.queuePosition);
  const inActiveQueue = ACTIVE_QUEUE.has(queueState);
  const terminalClass = (input.terminalClass ?? "").trim().toLowerCase();
  const terminalReason = (input.terminalReason ?? "").trim();

  // Active queue / In Progress wins over a leftover Failed PR badge so a
  // re-admitted scan is glanceable as processing (admit does not always flip
  // PR.status off Failed until the worker claims the job).
  if (inActiveQueue || status === "In Progress" || terminalClass === "processing" || terminalClass === "queued") {
    const label =
      queuePosition != null ? `processing #${queuePosition}` : "processing";
    const tipBase =
      queueState === "queued" || terminalClass === "queued"
        ? buildQueueWaitTooltip(queuePosition, input.queueGlobalLimit, input.queueRepoLimit)
        : "Processing — scan is admitted or running. Completed ≠ merge-ready; wait for the rating chip.";
    const tooltip =
      terminalReason && (queueState === "queued" || terminalClass === "queued")
        ? terminalReason
        : queuePosition != null && queueState !== "queued"
          ? `${tipBase} Currently #${queuePosition} in the queue.`
          : tipBase;
    return {
      kind: "processing",
      label,
      tone: "blue",
      tooltip,
      queuePosition,
    };
  }

  // Terminal failure classes win over a lagged Completed PR badge (issue #140).
  const failedByClass =
    terminalClass === "hard_fail" ||
    terminalClass === "quality_failure" ||
    terminalClass === "transport_failure" ||
    terminalClass === "infrastructure_failure" ||
    terminalClass === "gate_blocked" ||
    terminalClass === "unknown_failure";

  // Failed never looks completed-green, even if a stale terminal queue row exists.
  if (status === "Failed" || queueState === "failed" || failedByClass) {
    const reasonTip =
      terminalReason ||
      "Failed — the last scan did not finish successfully. Re-scan when ready; this is not completed.";
    return {
      kind: "failed",
      label: "failed",
      tone: "red",
      tooltip: reasonTip,
      queuePosition: null,
    };
  }

  if (status === "Merged") {
    return {
      kind: "merged",
      label: "merged",
      tone: "amber",
      tooltip: "Merged — branch is merged on the remote. Not an active review target.",
      queuePosition: null,
    };
  }

  if (status === "Completed" || status === "scanned") {
    return {
      kind: "completed",
      label: "completed",
      tone: "green",
      tooltip:
        "Completed — a scan finished. Check the rating chip to see if it is merge-ready (need 8+). Completed ≠ merge-ready.",
      queuePosition: null,
    };
  }

  // Pending, open, unknown — amber pending (never green).
  return {
    kind: "pending",
    label: "pending",
    tone: "amber",
    tooltip:
      "Pending — waiting to enter the scan queue. Not running yet. Not merge-ready.",
    queuePosition: null,
  };
}

function buildQueueWaitTooltip(
  position: number | null,
  globalLimit?: number | null,
  repoLimit?: number | null,
): string {
  const parts = [
    "Queued — waiting for a concurrent scan slot.",
  ];
  if (position != null) parts.push(`Position #${position}.`);
  if (globalLimit != null && Number.isFinite(globalLimit)) {
    parts.push(`Global limit ${Math.floor(globalLimit)}.`);
  }
  if (repoLimit != null && Number.isFinite(repoLimit)) {
    parts.push(`Repo limit ${Math.floor(repoLimit)}.`);
  }
  parts.push("Force does not bypass concurrent caps.");
  return parts.join(" ");
}

/**
 * Rating color bands: 1–4 red · 5–7 amber · 8–10 green · null → no score amber.
 * Tooltips explain the merge bar (need 8+).
 */
function formatRatingLabel(score: number): string {
  const n = Number.isInteger(score) ? score : Math.round(score * 10) / 10;
  return `${n}/10`;
}

export function presentRatingPill(rating: number | null | undefined): LayoutCRatingPill {
  if (rating == null || !Number.isFinite(rating)) {
    return {
      score: null,
      label: "no score",
      tone: "amber",
      tooltip:
        "No trusted score — scan finished without a usable rating. Not merge-ready (need 8+).",
    };
  }

  const score = rating;
  const label = formatRatingLabel(score);

  if (score >= 8) {
    return {
      score,
      label,
      tone: "green",
      tooltip: `${label} — at or above the merge bar (need 8+). Merge-ready if other gates pass.`,
    };
  }

  if (score >= 5) {
    return {
      score,
      label,
      tone: "amber",
      tooltip: `${label} — below the merge bar (need 8+). Fix findings and re-scan.`,
    };
  }

  return {
    score,
    label,
    tone: "red",
    tooltip: `${label} — well below the merge bar (need 8+). Expect serious issues; fix and re-scan.`,
  };
}

const SIZE_TIPS: Record<PrSizeTier, string> = {
  small:
    "Small PR — quick scan. Few files/lines so the review stays sharp and finishes fast.",
  medium:
    "Medium PR — normal scan cost. Still within the usual review budget.",
  large:
    "Large PR — scan quality may degrade. Longer run; consider splitting before merge pressure.",
  oversized:
    "Oversized PR — large diff. Scan will take longer and may miss cross-file issues; split if you can.",
};

/**
 * Size visual bands: small green · medium amber · oversized red.
 * Production `large` maps into the oversized (red) band; label stays "large".
 */
export function presentSizePill(
  tierOrProfile: PrSizeTier | { tier: PrSizeTier } | null | undefined,
): LayoutCSizePill {
  const tier: PrSizeTier | null =
    tierOrProfile == null
      ? null
      : typeof tierOrProfile === "string"
        ? tierOrProfile
        : tierOrProfile.tier;

  if (tier === "small") {
    return {
      tier,
      band: "small",
      label: "small",
      tone: "green",
      tooltip: SIZE_TIPS.small,
    };
  }

  if (tier === "medium") {
    return {
      tier,
      band: "medium",
      label: "medium",
      tone: "amber",
      tooltip: SIZE_TIPS.medium,
    };
  }

  if (tier === "large") {
    // Agreed collapse: large → oversized/red visual band (quality-risk).
    return {
      tier,
      band: "oversized",
      label: "large",
      tone: "red",
      tooltip: SIZE_TIPS.large,
    };
  }

  // oversized or unknown → oversized red (safe default for missing tier: treat as unknown medium? Spec wants three bands; null → medium amber is calmer)
  if (tier === "oversized") {
    return {
      tier,
      band: "oversized",
      label: "oversized",
      tone: "red",
      tooltip: SIZE_TIPS.oversized,
    };
  }

  return {
    tier: null,
    band: "medium",
    label: "medium",
    tone: "amber",
    tooltip: SIZE_TIPS.medium,
  };
}
