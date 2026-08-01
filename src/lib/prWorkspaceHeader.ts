/**
 * Layout-C PR workspace header model (pure).
 *
 * Composes:
 *   - buildSeamChips (pipeline seams)
 *   - isMergeReady (shared merge gate)
 *   - buildLayoutCHeaderChips (single chip row)
 *   - formatPrIdentity (two-line identity)
 *
 * UI maps chips + cloneFailed + identity only — no badge soup.
 */

import {
  buildLayoutCHeaderChips,
  type LayoutCHeaderChip,
} from "./layoutCHeaderChips";
import { isMergeReady } from "./mergeReady";
import {
  formatPrIdentity,
  type PrIdentityInput,
  type PrIdentityLines,
} from "./prIdentity";
import type { PrSizeTier } from "./prSizeProfile";
import type { ReviewStaleReason } from "./reviewStale";
import { buildSeamChips, type SeamChipInput } from "./seamChips";

export type PrWorkspaceHeaderInput = PrIdentityInput & {
  status: string;
  sizeTier?: PrSizeTier | { tier: PrSizeTier } | null;
  seam: SeamChipInput;
  /** Latest rating (falls back to seam.rating). */
  rating?: number | null;
  queueState?: string | null;
  queuePosition?: number | null;
  blockedGate?: string | null;
  stale?: boolean | null;
  staleReason?: ReviewStaleReason | null;
};

export type PrWorkspaceHeaderModel = {
  chips: LayoutCHeaderChip[];
  identity: PrIdentityLines;
  cloneFailed: boolean;
};

/** True when clone seam is failed — Run/Force should disable with tooltip. */
export function isCloneFailedForActions(input: SeamChipInput): boolean {
  const clone = buildSeamChips(input).find((c) => c.id === "clone");
  return clone?.tone === "fail";
}

/**
 * Build the layout-C header presentation model from workspace fields.
 */
export function buildPrWorkspaceHeaderModel(
  input: PrWorkspaceHeaderInput,
): PrWorkspaceHeaderModel {
  const blockedGate = input.blockedGate ?? input.seam.blockedGate ?? null;
  const rating =
    input.rating !== undefined ? input.rating : (input.seam.rating ?? null);

  const stale = input.stale ?? input.seam.stale;
  const staleReason = input.staleReason ?? input.seam.staleReason ?? null;

  const seamInput: SeamChipInput = {
    ...input.seam,
    rating,
    blockedGate,
    stale,
    staleReason,
  };

  const seams = buildSeamChips(seamInput);
  // isMergeReady treats omitted status as "finished" (legacy). Without a
  // run lifecycle signal, pass null so the gate returns no_run instead of
  // false-passing on a bare rating.
  const hasRunStatus =
    typeof seamInput.runStatus === "string" && seamInput.runStatus.length > 0;
  const merge = hasRunStatus
    ? isMergeReady({
        status: seamInput.runStatus,
        outcome: seamInput.runOutcome,
        rating,
        reliability: seamInput.reliability,
        refused: seamInput.refused,
        stale: seamInput.stale,
        staleReason: seamInput.staleReason,
      })
    : isMergeReady(null);

  const chips = buildLayoutCHeaderChips({
    seams,
    merge,
    blockedGate,
    status: input.status,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
    size: input.sizeTier,
    rating,
    stale,
    staleReason,
  });

  const identity = formatPrIdentity({
    title: input.title,
    sourceBranch: input.sourceBranch,
    githubPrNumber: input.githubPrNumber,
    ticketNumber: input.ticketNumber,
  });

  return {
    chips,
    identity,
    cloneFailed: isCloneFailedForActions(seamInput),
  };
}
