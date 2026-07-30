/**
 * Glanceable PR pipeline health: clone · webhook · index · checks · rating.
 *
 * Pure derivation from repo + review state already on the PR workspace.
 * "Scan finished" is not merge-ready — the rating chip uses isMergeReady.
 */

import { isMergeReady, type MergeReadyInput } from "./mergeReady";

export type SeamTone = "ok" | "warn" | "fail" | "pending" | "na";

export type SeamId = "clone" | "webhook" | "index" | "checks" | "rating";

export interface SeamChip {
  id: SeamId;
  label: string;
  tone: SeamTone;
  /** Short status word shown on the chip (e.g. "ok", "off", "blocked"). */
  detail: string;
  title: string;
}

export interface SeamChipInput {
  /** Local checkout or volume path present. */
  hasCheckout?: boolean | null;
  /** Last clone/fetch failure message when known. */
  lastFetchError?: string | null;
  /** Repo lifecycle status (may include "error" / "cloning"). */
  repoStatus?: string | null;
  /** Remote clone URL configured (null for pure local). */
  cloneUrl?: string | null;
  provider?: string | null;
  webhookEnabled?: boolean | null;
  webhookId?: string | null;
  indexedAt?: string | null;
  /** Review run lifecycle: completed | failed | in_progress | … */
  runStatus?: string | null;
  runOutcome?: string | null;
  reliability?: string | null;
  rating?: number | null;
  refused?: boolean | null;
  stale?: boolean | null;
  /** Named prelude/gate block when scan cannot start (index, clone, config…). */
  blockedGate?: string | null;
  /** Deterministic check infrastructure failure on the latest run. */
  checksFailed?: boolean | null;
}

function cloneChip(input: SeamChipInput): SeamChip {
  const label = "clone";
  if (input.lastFetchError) {
    return {
      id: "clone",
      label,
      tone: "fail",
      detail: "failed",
      title: `Clone failed: ${input.lastFetchError}`,
    };
  }
  if (input.repoStatus === "error") {
    return {
      id: "clone",
      label,
      tone: "fail",
      detail: "failed",
      title: "Repository is in error state — clone or sync failed.",
    };
  }
  if (input.repoStatus === "cloning") {
    return {
      id: "clone",
      label,
      tone: "pending",
      detail: "cloning",
      title: "Clone in progress.",
    };
  }
  if (input.blockedGate === "clone" || input.blockedGate === "CLONE_FAILED") {
    return {
      id: "clone",
      label,
      tone: "fail",
      detail: "blocked",
      title: "Blocked at clone — fix fetch credentials or path, then re-scan.",
    };
  }
  if (input.hasCheckout) {
    return {
      id: "clone",
      label,
      tone: "ok",
      detail: "ready",
      title: "Checkout ready.",
    };
  }
  // Pure local without path is unusual; remote without checkout is not ready.
  const remote = Boolean(input.cloneUrl) || input.provider === "github" || input.provider === "gitlab";
  if (remote) {
    return {
      id: "clone",
      label,
      tone: "warn",
      detail: "missing",
      title: "No server checkout yet — clone or wait for webhook/poller fetch.",
    };
  }
  return {
    id: "clone",
    label,
    tone: "pending",
    detail: "unknown",
    title: "Clone state unknown.",
  };
}

function webhookChip(input: SeamChipInput): SeamChip {
  const label = "webhook";
  const remote = Boolean(input.cloneUrl) || input.provider === "github" || input.provider === "gitlab";
  if (!remote && !input.webhookId) {
    return {
      id: "webhook",
      label,
      tone: "na",
      detail: "n/a",
      title: "Local repo — webhook not required.",
    };
  }
  if (input.webhookEnabled && input.webhookId) {
    return {
      id: "webhook",
      label,
      tone: "ok",
      detail: "on",
      title: "Webhook installed and processing enabled.",
    };
  }
  if (input.webhookId && !input.webhookEnabled) {
    return {
      id: "webhook",
      label,
      tone: "warn",
      detail: "idle",
      title: "Webhook exists but processing is off — deliveries are ignored.",
    };
  }
  return {
    id: "webhook",
    label,
    tone: "warn",
    detail: "off",
    title: "Webhook not configured — AFK auto-rescan will not receive push events.",
  };
}

function indexChip(input: SeamChipInput): SeamChip {
  const label = "index";
  if (
    input.blockedGate === "index" ||
    input.blockedGate === "INDEX_REQUIRED" ||
    input.blockedGate === "INDEXING_IN_PROGRESS" ||
    input.blockedGate === "STALE_INDEX" ||
    input.blockedGate === "REINDEX_FAILED"
  ) {
    return {
      id: "index",
      label,
      tone: "fail",
      detail: "blocked",
      title: `Blocked at index (${input.blockedGate}).`,
    };
  }
  if (input.repoStatus === "indexing") {
    return {
      id: "index",
      label,
      tone: "pending",
      detail: "indexing",
      title: "Indexing in progress.",
    };
  }
  if (input.indexedAt) {
    return {
      id: "index",
      label,
      tone: "ok",
      detail: "ready",
      title: `Indexed at ${input.indexedAt}.`,
    };
  }
  return {
    id: "index",
    label,
    tone: "fail",
    detail: "required",
    title: "Index required before review — open the repo and run Index now.",
  };
}

function checksChip(input: SeamChipInput): SeamChip {
  const label = "checks";
  if (
    input.blockedGate === "checks" ||
    input.blockedGate === "CONFIG_REQUIRED" ||
    input.blockedGate === "DIFF_UNAVAILABLE"
  ) {
    return {
      id: "checks",
      label,
      tone: "fail",
      detail: "blocked",
      title: `Blocked at ${input.blockedGate}.`,
    };
  }
  if (input.checksFailed || input.runStatus === "failed") {
    return {
      id: "checks",
      label,
      tone: "fail",
      detail: "failed",
      title: "Latest run failed (install/typecheck/lint or pipeline error).",
    };
  }
  if (input.runOutcome === "skipped") {
    return {
      id: "checks",
      label,
      tone: "warn",
      detail: "skipped",
      title: "Review skipped (trivial/empty diff) — not a full check pass.",
    };
  }
  if (input.runStatus === "in_progress" || input.runStatus === "queued") {
    return {
      id: "checks",
      label,
      tone: "pending",
      detail: "running",
      title: "Checks / review in progress.",
    };
  }
  if (input.runStatus === "completed") {
    return {
      id: "checks",
      label,
      tone: "ok",
      detail: "done",
      title: "Scan finished — checks stage completed. See rating for merge readiness.",
    };
  }
  return {
    id: "checks",
    label,
    tone: "pending",
    detail: "idle",
    title: "No completed scan yet.",
  };
}

function ratingChip(input: SeamChipInput): SeamChip {
  const label = "rating";
  // Bare rating without a finished run is not merge-ready (no run to gate on).
  if (input.runStatus == null && input.runOutcome == null) {
    return {
      id: "rating",
      label,
      tone: "pending",
      detail: "—",
      title: "No completed scan yet — not merge-ready.",
    };
  }
  const mergeInput: MergeReadyInput = {
    status: input.runStatus,
    outcome: input.runOutcome,
    rating: input.rating,
    reliability: input.reliability,
    refused: input.refused,
    stale: input.stale,
  };
  const merge = isMergeReady(mergeInput);

  if (merge.mergeReady) {
    return {
      id: "rating",
      label,
      tone: "ok",
      detail: `${input.rating}/10`,
      title: "Merge ready — shared isMergeReady gate passed.",
    };
  }

  // In-flight / no finished run: pending (not a red "fail" on an old score)
  if (
    input.runStatus === "in_progress" ||
    input.runStatus === "queued" ||
    merge.mergeBlockReason === "no_run" ||
    merge.mergeBlockReason === "not_finished"
  ) {
    return {
      id: "rating",
      label,
      tone: "pending",
      detail: "—",
      title: merge.message ?? "Scan not finished — not merge-ready.",
    };
  }

  const detail =
    input.rating != null ? `${input.rating}/10` : merge.mergeBlockReason ?? "not ready";

  return {
    id: "rating",
    label,
    tone: "fail",
    detail,
    title: merge.mergeBlockReason
      ? `Not merge-ready: ${merge.mergeBlockReason}`
      : "Not merge-ready (shared isMergeReady gate).",
  };
}

/** Build the five pipeline seam chips for the PR header status row. */
export function buildSeamChips(input: SeamChipInput): SeamChip[] {
  return [
    cloneChip(input),
    webhookChip(input),
    indexChip(input),
    checksChip(input),
    ratingChip(input),
  ];
}
