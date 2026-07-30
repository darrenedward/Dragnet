/**
 * Layout-C PR header + sidebar presenters.
 *
 * Pure derivation only — colors/labels for chips and identity strings.
 * Merge readiness always comes from the shared isMergeReady gate (or an
 * already-evaluated mergeReady flag from the findings API).
 */

import { buildSeamChips, type SeamChipInput } from "./seamChips";
import { isMergeReady, type MergeBlockReason } from "./mergeReady";
import type { PrSizeTier } from "./prSizeProfile";

export type PillTone = "red" | "amber" | "green" | "blue" | "neutral";

export type LayoutCStatusKind = "pending" | "processing" | "completed" | "failed";

export interface PillModel {
  label: string;
  tone: PillTone;
  title: string;
}

export interface StatusPillModel extends PillModel {
  kind: LayoutCStatusKind;
}

export interface LayoutCChip {
  id: string;
  label: string;
  tone: PillTone;
  title: string;
}

export interface PrIdentityModel {
  prLine: string;
  issueLine: string | null;
  branchFallback: string | null;
  ticketNumber: number | null;
  githubPrNumber: number | null;
  title: string;
}

export interface SidebarPrRowModel {
  title: string;
  prNumberLabel: string | null;
  issueNumberLabel: string | null;
  status: StatusPillModel;
  rating: PillModel | null;
}

const TICKET_RE = /(?:^|\/)ticket-(\d+)(?:-|$)/i;

/** Parse `ticket-24-…` (or path-prefixed) branch names. Never invents IDs. */
export function parseTicketFromBranch(
  branch: string | null | undefined,
): number | null {
  if (!branch) return null;
  const m = branch.match(TICKET_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatPrIdentity(input: {
  title: string;
  githubPrNumber?: number | null;
  sourceBranch?: string | null;
  ticketNumber?: number | null;
}): PrIdentityModel {
  const title = input.title || "Untitled";
  const githubPrNumber =
    input.githubPrNumber != null && Number.isFinite(input.githubPrNumber)
      ? Number(input.githubPrNumber)
      : null;
  const branch = input.sourceBranch?.trim() || null;
  const ticketNumber =
    input.ticketNumber != null && Number.isFinite(input.ticketNumber)
      ? Number(input.ticketNumber)
      : parseTicketFromBranch(branch);

  const prLine =
    githubPrNumber != null
      ? `GitHub PR: #${githubPrNumber} — ${title}`
      : `GitHub PR: ${title}`;

  if (ticketNumber != null && branch) {
    return {
      prLine,
      issueLine: `GitHub Issue: #${ticketNumber} — ${branch}`,
      branchFallback: null,
      ticketNumber,
      githubPrNumber,
      title,
    };
  }
  if (ticketNumber != null) {
    return {
      prLine,
      issueLine: `GitHub Issue: #${ticketNumber}`,
      branchFallback: null,
      ticketNumber,
      githubPrNumber,
      title,
    };
  }
  return {
    prLine,
    issueLine: null,
    branchFallback: branch,
    ticketNumber: null,
    githubPrNumber,
    title,
  };
}

const RATING_TIPS = {
  none: "No trusted score — scan finished without a usable rating. Not merge-ready.",
  low: (n: number) =>
    `${n}/10 — well below the merge bar. Expect serious issues; fix and re-scan.`,
  mid: (n: number) =>
    `${n}/10 — below the merge bar (need 8+). Fix findings and re-scan.`,
  high: (n: number) =>
    `${n}/10 — at or above the merge bar (need 8+). Merge-ready if other gates pass.`,
} as const;

/** Rating bands: 1–4 red · 5–7 amber · 8–10 green · null → no score amber. */
export function mapRatingPill(rating: number | null | undefined): PillModel {
  if (rating == null || !Number.isFinite(rating)) {
    return {
      label: "no score",
      tone: "amber",
      title: RATING_TIPS.none,
    };
  }
  const n = Math.round(Number(rating));
  if (n >= 8) {
    return { label: `${n}/10`, tone: "green", title: RATING_TIPS.high(n) };
  }
  if (n >= 5) {
    return { label: `${n}/10`, tone: "amber", title: RATING_TIPS.mid(n) };
  }
  return { label: `${n}/10`, tone: "red", title: RATING_TIPS.low(n) };
}

const SIZE_TIPS: Record<PrSizeTier, string> = {
  small:
    "Small PR — quick scan. Few files/lines so the review stays sharp and finishes fast.",
  medium: "Medium PR — normal scan cost. Still within the usual review budget.",
  large:
    "Large PR — elevated scan cost. Quality may degrade; consider splitting if practical.",
  oversized:
    "Oversized PR — large diff. Scan will take longer and may miss cross-file issues; split if you can.",
};

/**
 * Size visual bands: small green · medium amber · oversized red.
 * Production `large` maps into the amber band (same as medium) so only
 * oversized is red.
 */
export function mapSizeBand(
  tier: PrSizeTier | null | undefined,
): PillModel | null {
  if (!tier) return null;
  if (tier === "small") {
    return { label: "small", tone: "green", title: SIZE_TIPS.small };
  }
  if (tier === "medium") {
    return { label: "medium", tone: "amber", title: SIZE_TIPS.medium };
  }
  if (tier === "large") {
    return { label: "large", tone: "amber", title: SIZE_TIPS.large };
  }
  return { label: "oversized", tone: "red", title: SIZE_TIPS.oversized };
}

const STATUS_TIPS: Record<LayoutCStatusKind, string> = {
  pending: "Pending — waiting to enter the scan queue. Not running yet.",
  processing:
    "Processing — admitted to the scan queue or actively reviewing.",
  completed:
    "Completed — a scan finished. Check the rating chip to see if it is merge-ready (8+). Completed ≠ merge-ready.",
  failed: "Failed — last scan failed. Fix the cause and re-run or force re-scan.",
};

export function mapPrStatusPill(input: {
  status: string;
  queueState?: string | null;
  queuePosition?: number | null;
}): StatusPillModel {
  const q = input.queueState;
  const pos =
    input.queuePosition != null && Number.isFinite(input.queuePosition)
      ? Number(input.queuePosition)
      : null;

  if (q === "queued" || q === "running") {
    const label = pos != null ? `processing #${pos}` : "processing";
    const tip =
      pos != null
        ? `${STATUS_TIPS.processing} Currently #${pos} in the queue.`
        : STATUS_TIPS.processing;
    return { kind: "processing", label, tone: "blue", title: tip };
  }

  const s = input.status;
  if (s === "In Progress" || s === "in_progress") {
    const label = pos != null ? `processing #${pos}` : "processing";
    return {
      kind: "processing",
      label,
      tone: "blue",
      title:
        pos != null
          ? `${STATUS_TIPS.processing} Currently #${pos} in the queue.`
          : STATUS_TIPS.processing,
    };
  }
  if (s === "Failed" || s === "failed") {
    return {
      kind: "failed",
      label: "failed",
      tone: "red",
      title: STATUS_TIPS.failed,
    };
  }
  if (s === "Completed" || s === "completed" || s === "scanned" || s === "Merged") {
    return {
      kind: "completed",
      label: "completed",
      tone: "green",
      title: STATUS_TIPS.completed,
    };
  }
  // Pending / open / default
  const label = pos != null ? `pending #${pos}` : "pending";
  return {
    kind: "pending",
    label,
    tone: "amber",
    title:
      pos != null
        ? `${STATUS_TIPS.pending} Currently #${pos} among waiting jobs.`
        : STATUS_TIPS.pending,
  };
}

export interface LayoutCChipInput extends SeamChipInput {
  prStatus: string;
  sizeTier?: PrSizeTier | null;
  /** Pre-evaluated shared gate from findings API when available. */
  mergeReady?: boolean | null;
  mergeBlockReason?: MergeBlockReason | string | null;
  mergeMessage?: string | null;
  queueState?: string | null;
  queuePosition?: number | null;
}

/**
 * One chip row for layout C:
 * status · size · webhook · cloned · indexed · rating · merge [| blocked]
 */
export function buildLayoutCChips(input: LayoutCChipInput): LayoutCChip[] {
  const seams = buildSeamChips(input);
  const byId = Object.fromEntries(seams.map((c) => [c.id, c]));

  const status = mapPrStatusPill({
    status: input.prStatus,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
  });

  const chips: LayoutCChip[] = [
    {
      id: "status",
      label: status.label,
      tone: status.tone,
      title: status.title,
    },
  ];

  const size = mapSizeBand(input.sizeTier);
  if (size) {
    chips.push({ id: "size", label: size.label, tone: size.tone, title: size.title });
  }

  const webhook = byId.webhook;
  if (webhook) {
    // Binary primary chip: installed+processing → on; idle/off/warn → off.
    // Local n/a stays labeled n/a with neutral tone.
    if (webhook.tone === "na") {
      chips.push({
        id: "webhook",
        label: "webhook n/a",
        tone: "neutral",
        title: webhook.title,
      });
    } else if (webhook.tone === "ok") {
      chips.push({
        id: "webhook",
        label: "webhook on",
        tone: "green",
        title:
          "Webhook on — GitHub notifies Dragnet on push and PR events (installed + processing).",
      });
    } else {
      chips.push({
        id: "webhook",
        label: "webhook off",
        tone: "red",
        title:
          webhook.detail === "idle"
            ? "Webhook off — hook exists but processing is disabled. No automatic GitHub → Dragnet events."
            : "Webhook off — no automatic GitHub → Dragnet events. Scans only run when you trigger them.",
      });
    }
  }

  const clone = byId.clone;
  if (clone) {
    if (clone.tone === "ok") {
      chips.push({
        id: "cloned",
        label: "cloned",
        tone: "green",
        title: "Clone OK — local checkout is ready for scans.",
      });
    } else if (clone.tone === "pending" && clone.detail === "cloning") {
      chips.push({
        id: "cloned",
        label: "cloning",
        tone: "amber",
        title: clone.title || "Clone in progress.",
      });
    } else if (clone.tone === "fail") {
      chips.push({
        id: "cloned",
        label: "clone failed",
        tone: "red",
        title: clone.title || "Clone failed — fix checkout before scans can run.",
      });
    } else {
      // warn (missing checkout) or unknown pending — not a failed clone.
      chips.push({
        id: "cloned",
        label: "not cloned",
        tone: "red",
        title: clone.title || "No server checkout yet — clone before scans can run.",
      });
    }
  }

  const index = byId.index;
  if (index) {
    if (index.tone === "ok") {
      chips.push({
        id: "indexed",
        label: "indexed",
        tone: "green",
        title: "Indexed — AST/symbol index is present for smarter review context.",
      });
    } else if (index.tone === "pending") {
      chips.push({
        id: "indexed",
        label: "indexing",
        tone: "amber",
        title: index.title || "Indexing in progress.",
      });
    } else {
      chips.push({
        id: "indexed",
        label: "index missing",
        tone: "red",
        title: index.title || "Index missing — run Index now so reviews have codebase context.",
      });
    }
  }

  const rating = mapRatingPill(input.rating);
  chips.push({
    id: "rating",
    label: rating.label,
    tone: rating.tone,
    title: rating.title,
  });

  // Prefer findings-API mergeReady when provided; else evaluate shared gate.
  let mergeReady = input.mergeReady;
  let mergeTitle: string;
  if (mergeReady == null) {
    const gate = isMergeReady({
      status: input.runStatus,
      outcome: input.runOutcome,
      rating: input.rating,
      reliability: input.reliability,
      refused: input.refused,
      stale: input.stale,
    });
    mergeReady = gate.mergeReady;
    mergeTitle = gate.mergeReady
      ? "Merge ready — shared isMergeReady gate passed (rating ≥ 8, not skipped, reliability complete/absent, not refused, not stale)."
      : gate.message
        ? `Not merge-ready — ${gate.message}`
        : "Not merge-ready — need rating ≥ 8 with gates complete. Completed ≠ merge-ready.";
  } else if (mergeReady) {
    mergeTitle =
      "Merge ready — shared isMergeReady gate passed (rating ≥ 8, not skipped, reliability complete/absent, not refused, not stale).";
  } else {
    const reason = input.mergeMessage || input.mergeBlockReason;
    mergeTitle = reason
      ? `Not merge-ready — ${reason}`
      : "Not merge-ready — need rating ≥ 8 with gates complete. Completed ≠ merge-ready.";
  }

  // Preserve checks seam context in merge tooltip when relevant.
  const checks = byId.checks;
  if (
    checks &&
    (checks.tone === "fail" || input.checksFailed) &&
    !mergeReady
  ) {
    mergeTitle = `${mergeTitle} Checks: ${checks.detail} — ${checks.title}`;
  }

  chips.push({
    id: "merge",
    label: mergeReady ? "merge ready" : "not ready",
    tone: mergeReady ? "green" : "amber",
    title: mergeTitle,
  });

  if (input.blockedGate) {
    chips.push({
      id: "blocked",
      label: `blocked at ${input.blockedGate}`,
      tone: "amber",
      title:
        input.mergeMessage ||
        `Blocked at ${input.blockedGate} — a prelude/gate refused work. Fix the gate, then re-run.`,
    });
  }

  return chips;
}

/** True when clone seam is failed — Run/Force should disable with tooltip. */
export function isCloneFailedForActions(input: SeamChipInput): boolean {
  const clone = buildSeamChips(input).find((c) => c.id === "clone");
  return clone?.tone === "fail";
}

export function buildSidebarPrRow(input: {
  title: string;
  githubPrNumber?: number | null;
  sourceBranch?: string | null;
  ticketNumber?: number | null;
  status: string;
  rating?: number | null;
  queueState?: string | null;
  queuePosition?: number | null;
}): SidebarPrRowModel {
  const ticketRaw =
    input.ticketNumber != null ? Number(input.ticketNumber) : NaN;
  const ticket = Number.isFinite(ticketRaw) && ticketRaw > 0
    ? ticketRaw
    : parseTicketFromBranch(input.sourceBranch);
  const prRaw =
    input.githubPrNumber != null ? Number(input.githubPrNumber) : NaN;
  const prNum = Number.isFinite(prRaw) && prRaw > 0 ? prRaw : null;

  const status = mapPrStatusPill({
    status: input.status,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
  });

  // Show rating when completed/failed or when a score exists (incl. null completed → no score).
  const showRating =
    status.kind === "completed" ||
    status.kind === "failed" ||
    input.rating != null;

  return {
    title: input.title,
    prNumberLabel: prNum != null ? `PR #${prNum}` : null,
    issueNumberLabel: ticket != null ? `issue #${ticket}` : null,
    status,
    rating: showRating ? mapRatingPill(input.rating) : null,
  };
}
