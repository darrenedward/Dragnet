/**
 * Layout-C header chip-row mapper (pure).
 *
 * One ordered list:
 *   status · size · webhook · cloned · indexed · rating · merge ready | not ready
 *
 * Maps existing seam builder chips + shared isMergeReady / mergeReadyLabel +
 * layout-C status/size/rating pill presenters. Does not fork merge logic.
 *
 * Checks/reliability detail lives in tooltips — not a second badge row.
 * "Scan finished" (status completed) is not merge-ready.
 */

import type { SeamChip, SeamTone } from "./seamChips";
import {
  presentRatingPill,
  presentSizePill,
  presentStatusPill,
  type LayoutCPillTone,
} from "./layoutCPills";
import { mergeReadyLabel, type MergeReadyResult } from "./mergeReady";
import type { PrSizeTier } from "./prSizeProfile";
import type { ReviewStaleReason } from "./reviewStale";
import { reviewStaleLabel } from "./reviewStale";

export type LayoutCHeaderChipId =
  | "status"
  | "size"
  | "webhook"
  | "cloned"
  | "indexed"
  | "rating"
  | "merge";

export type LayoutCHeaderChip = {
  id: LayoutCHeaderChipId;
  label: string;
  tone: LayoutCPillTone;
  tooltip: string;
};

export type LayoutCHeaderChipInput = {
  /** Pre-built seam chips from buildSeamChips (clone · webhook · index · checks · rating). */
  seams: SeamChip[];
  /** Shared merge gate result — callers pass isMergeReady(...); do not re-derive. */
  merge: MergeReadyResult;
  /** Named prelude/gate block when present (clone, index, config, …). */
  blockedGate?: string | null;
  /** Production PR.status (Pending | In Progress | Completed | Failed | Merged | …). */
  status: string;
  /** Active queue job state when known (queued | running | …). */
  queueState?: string | null;
  /** 1-based queue depth when known. */
  queuePosition?: number | null;
  /** Size tier or profile (findings/workspace sizeProfile). */
  size?: PrSizeTier | { tier: PrSizeTier } | null;
  /** Latest rating for the rating pill (null → "no score"). */
  rating?: number | null;
  /** When the completed run is stale vs tip/diff. */
  stale?: boolean | null;
  staleReason?: ReviewStaleReason | null;
};

const ORDER: LayoutCHeaderChipId[] = [
  "status",
  "size",
  "webhook",
  "cloned",
  "indexed",
  "rating",
  "merge",
];

function seamToneToPill(tone: SeamTone): LayoutCPillTone {
  switch (tone) {
    case "ok":
      return "green";
    case "fail":
      return "red";
    case "pending":
      return "blue";
    case "warn":
    case "na":
    default:
      return "amber";
  }
}

function findSeam(seams: SeamChip[], id: SeamChip["id"]): SeamChip | undefined {
  return seams.find((s) => s.id === id);
}

function webhookFromSeam(seam: SeamChip | undefined): LayoutCHeaderChip {
  if (!seam) {
    return {
      id: "webhook",
      label: "webhook off",
      tone: "amber",
      tooltip: "Webhook state unknown.",
    };
  }
  let label = "webhook off";
  if (seam.tone === "ok") label = "webhook on";
  else if (seam.detail === "n/a") label = "webhook n/a";
  else if (seam.detail === "idle") label = "webhook idle";
  return {
    id: "webhook",
    label,
    tone: seamToneToPill(seam.tone),
    tooltip: seam.title,
  };
}

function clonedFromSeam(seam: SeamChip | undefined): LayoutCHeaderChip {
  if (!seam) {
    return {
      id: "cloned",
      label: "clone unknown",
      tone: "amber",
      tooltip: "Clone state unknown.",
    };
  }
  let label = "clone unknown";
  if (seam.tone === "ok") label = "cloned";
  else if (seam.detail === "cloning") label = "cloning";
  else if (seam.detail === "failed" || seam.detail === "blocked") label = "clone failed";
  else if (seam.detail === "missing") label = "clone missing";
  return {
    id: "cloned",
    label,
    tone: seamToneToPill(seam.tone),
    tooltip: seam.title,
  };
}

function indexedFromSeam(seam: SeamChip | undefined): LayoutCHeaderChip {
  if (!seam) {
    return {
      id: "indexed",
      label: "index missing",
      tone: "red",
      tooltip: "Index state unknown.",
    };
  }
  let label = "index missing";
  if (seam.tone === "ok") label = "indexed";
  else if (seam.detail === "indexing") label = "indexing";
  else if (seam.detail === "blocked") label = "index blocked";
  else if (seam.detail === "required") label = "index missing";
  return {
    id: "indexed",
    label,
    tone: seamToneToPill(seam.tone),
    tooltip: seam.title,
  };
}

function mergeFromGate(
  merge: MergeReadyResult,
  blockedGate: string | null | undefined,
  checks: SeamChip | undefined,
  stale?: boolean | null,
  staleReason?: ReviewStaleReason | null,
): LayoutCHeaderChip {
  // Blocked-at-{gate} is the single clear signal when a prelude gate refused work.
  if (blockedGate) {
    const label = mergeReadyLabel(merge, blockedGate);
    return {
      id: "merge",
      label,
      tone: "amber",
      tooltip: label,
    };
  }

  if (merge.mergeReady) {
    let tooltip = "Merge ready — shared isMergeReady gate passed.";
    if (checks && checks.tone !== "ok" && checks.tone !== "na") {
      tooltip = `${tooltip} Checks: ${checks.detail} — ${checks.title}`;
    }
    return {
      id: "merge",
      label: "merge ready",
      tone: "green",
      tooltip,
    };
  }

  // Stale / tip-mismatch: keep the not-ready chip, name tip in the label.
  if (merge.mergeBlockReason === "stale" || stale === true) {
    const tipLabel =
      staleReason === "tip_mismatch" ? "tip mismatch" : "stale review";
    return {
      id: "merge",
      label: tipLabel,
      tone: "amber",
      tooltip: merge.message ?? reviewStaleLabel(staleReason),
    };
  }

  // Not ready — short label; reason + checks live in tooltip only.
  const reason = merge.message ?? "Not merge-ready.";
  let tooltip = reason;
  if (checks && checks.tone !== "ok" && checks.tone !== "na") {
    tooltip = `${reason} Checks: ${checks.detail} — ${checks.title}`;
  }

  return {
    id: "merge",
    label: "not ready",
    tone: "amber",
    tooltip,
  };
}

/**
 * Build the single layout-C header chip row.
 * Input: seams + merge gate result + size + status/queue (+ blocked gate).
 */
export function buildLayoutCHeaderChips(
  input: LayoutCHeaderChipInput,
): LayoutCHeaderChip[] {
  const status = presentStatusPill({
    status: input.status,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
  });
  const size = presentSizePill(input.size);
  const ratingSeam = findSeam(input.seams, "rating");
  // Prefer seam rating presentation when stale/tip-mismatch so the chip
  // row matches "tip stale" language instead of a bare score.
  const ratingPill = presentRatingPill(input.rating);
  const rating: LayoutCHeaderChip =
    ratingSeam && (input.stale === true || input.merge.mergeBlockReason === "stale")
      ? {
          id: "rating",
          label:
            ratingSeam.detail === "tip stale"
              ? "tip stale"
              : ratingPill.label,
          tone: seamToneToPill(ratingSeam.tone),
          tooltip: ratingSeam.title || ratingPill.tooltip,
        }
      : {
          id: "rating",
          label: ratingPill.label,
          tone: ratingPill.tone,
          tooltip: ratingPill.tooltip,
        };

  const webhook = webhookFromSeam(findSeam(input.seams, "webhook"));
  const cloned = clonedFromSeam(findSeam(input.seams, "clone"));
  const indexed = indexedFromSeam(findSeam(input.seams, "index"));
  const checks = findSeam(input.seams, "checks");
  const merge = mergeFromGate(
    input.merge,
    input.blockedGate,
    checks,
    input.stale,
    input.staleReason,
  );

  const byId: Record<LayoutCHeaderChipId, LayoutCHeaderChip> = {
    status: {
      id: "status",
      label: status.label,
      tone: status.tone,
      tooltip: status.tooltip,
    },
    size: {
      id: "size",
      label: size.label,
      tone: size.tone,
      tooltip: size.tooltip,
    },
    webhook,
    cloned,
    indexed,
    rating,
    merge,
  };

  return ORDER.map((id) => byId[id]);
}
