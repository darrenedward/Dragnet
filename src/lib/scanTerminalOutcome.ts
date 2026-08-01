/**
 * Single scan terminal outcome contract (issue #140 / #135).
 *
 * Sidebar, header chips, findings API, and `/dragnet` status all map through
 * this pure helper so a hard fail cannot look like Completed / Success.
 *
 * "Scan finished" is not merge-ready. Only an earned AI success (valid rating
 * after submitReview) is `success`. Null rating after an AI attempt, dual
 * quality_failure, transport exhaustion, gates, and infra are failed classes.
 */

import type { LayoutCStatusKind } from "./layoutCPills";
import type { OutcomeClass } from "./failureClassifier";

/** Scan-level terminal (or in-flight) class — not per-provider OutcomeClass. */
export type ScanTerminalClass =
  | "success"
  | "skipped"
  | "quality_failure"
  | "transport_failure"
  | "hard_fail"
  | "gate_blocked"
  | "infrastructure_failure"
  | "interrupted"
  | "processing"
  | "queued"
  | "pending"
  | "unknown_failure";

export type ScanTerminalReasonKind =
  | "none"
  | "success"
  | "skipped"
  | "quality"
  | "transport"
  | "gate"
  | "queue"
  | "infrastructure"
  | "interrupted"
  | "unknown";

export type ScanPrimaryCta = "none" | "rescan" | "force_rescan";

export type ScanTerminalOutcome = {
  class: ScanTerminalClass;
  /** Glanceable lifecycle kind for layout-C status pills. */
  uiStatusKind: LayoutCStatusKind;
  /** Human label for banners / chips (Failed, Processing, Completed, …). */
  label: string;
  /** Operator-facing reason (quality vs transport vs gate vs queue). */
  reason: string;
  reasonKind: ScanTerminalReasonKind;
  systemWarn: string | null;
  primaryCta: ScanPrimaryCta;
  isFailed: boolean;
  isProcessing: boolean;
  /** True when this is an earned AI pass (merge gate may still fail). */
  isEarnedSuccess: boolean;
  queuePosition: number | null;
};

export type ScanTerminalInput = {
  /** PullRequest.status */
  prStatus?: string | null;
  /** ReviewRun.status */
  runStatus?: string | null;
  /** ReviewRun.outcome — reviewed | skipped | null */
  runOutcome?: string | null;
  rating?: number | null;
  systemWarn?: string | null;
  /** Persisted or live terminal class when known. */
  terminalClass?: string | null;
  infrastructureFailure?: boolean | null;
  interrupted?: boolean | null;
  /** Live scan HTTP success flag. */
  success?: boolean | null;
  blockedGate?: string | null;
  queueState?: string | null;
  queuePosition?: number | null;
  /** Optional concurrent-slot context for queue wait copy. */
  queueSlots?: {
    globalLimit?: number | null;
    repoLimit?: number | null;
  } | null;
  /** Provider outcomes from tokensUsed (quality/transport chain). */
  providerOutcomes?: Array<string | null | undefined> | null;
  /** usedModel === "none (skipped)" trivial path */
  usedModel?: string | null;
};

const ACTIVE_QUEUE = new Set(["queued", "running"]);

function normalizePos(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function lower(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function hasProviderOutcome(
  outcomes: Array<string | null | undefined> | null | undefined,
  want: OutcomeClass | string,
): boolean {
  if (!outcomes?.length) return false;
  return outcomes.some((o) => o === want);
}

function allProvidersQualityOrEmpty(
  outcomes: Array<string | null | undefined> | null | undefined,
): boolean {
  if (!outcomes?.length) return false;
  const review = outcomes.filter(
    (o) =>
      o === "success" ||
      o === "quality_failure" ||
      o === "transport_failure" ||
      o === "unknown_failure",
  );
  if (review.length === 0) return false;
  return review.every((o) => o === "quality_failure" || o === "unknown_failure");
}

function reasonFromWarn(
  warn: string | null | undefined,
): { kind: ScanTerminalReasonKind; class: ScanTerminalClass } | null {
  const w = lower(warn);
  if (!w) return null;
  if (w.includes("hard_fail") || w.includes("hard-fail") || w.includes("hard fail")) {
    return { kind: "quality", class: "hard_fail" };
  }
  if (
    w.includes("submitreview") ||
    w.includes("quality_failure") ||
    w.includes("quality failure") ||
    w.includes("without calling submit") ||
    w.includes("rating nulled") ||
    w.includes("all were rejected") ||
    w.includes("malformed")
  ) {
    return { kind: "quality", class: "quality_failure" };
  }
  if (
    w.includes("infrastructure") ||
    w.includes("tier 2") ||
    w.includes("deterministic checks failed")
  ) {
    return { kind: "infrastructure", class: "infrastructure_failure" };
  }
  if (
    w.includes("econnreset") ||
    w.includes("etimedout") ||
    w.includes("429") ||
    w.includes("transport") ||
    w.includes("network") ||
    w.includes("fetch failed") ||
    w.includes("socket")
  ) {
    return { kind: "transport", class: "transport_failure" };
  }
  if (w.includes("aborted") || w.includes("interrupt")) {
    return { kind: "interrupted", class: "interrupted" };
  }
  return null;
}

function queueWaitReason(
  position: number | null,
  slots: ScanTerminalInput["queueSlots"],
): string {
  const parts: string[] = [];
  if (position != null) parts.push(`queue position #${position}`);
  const g = slots?.globalLimit;
  const r = slots?.repoLimit;
  if (g != null && Number.isFinite(g)) {
    parts.push(`waiting for a global concurrent slot (limit ${Math.floor(g)})`);
  } else {
    parts.push("waiting for a concurrent scan slot");
  }
  if (r != null && Number.isFinite(r)) {
    parts.push(`repo limit ${Math.floor(r)}`);
  }
  return parts.join(" — ");
}

function failedOutcome(
  cls: ScanTerminalClass,
  reasonKind: ScanTerminalReasonKind,
  reason: string,
  systemWarn: string | null,
  primaryCta: ScanPrimaryCta = "rescan",
): ScanTerminalOutcome {
  return {
    class: cls,
    uiStatusKind: "failed",
    label: "Failed",
    reason,
    reasonKind,
    systemWarn,
    primaryCta,
    isFailed: true,
    isProcessing: false,
    isEarnedSuccess: false,
    queuePosition: null,
  };
}

/**
 * Classify a scan attempt into the shared terminal outcome contract.
 */
export function classifyScanTerminalOutcome(input: ScanTerminalInput): ScanTerminalOutcome {
  const prStatus = (input.prStatus ?? "").trim();
  const runStatus = lower(input.runStatus);
  const runOutcome = lower(input.runOutcome);
  const queueState = lower(input.queueState);
  const queuePosition = normalizePos(input.queuePosition);
  const systemWarn = input.systemWarn?.trim() || null;
  const blockedGate = input.blockedGate?.trim() || null;
  const usedModel = (input.usedModel ?? "").trim();
  const persistedClass = lower(input.terminalClass);

  // In-flight wins: never flash Completed/Failed over real queue/run work.
  if (input.interrupted === true || runStatus === "interrupted") {
    return {
      class: "interrupted",
      uiStatusKind: "processing",
      label: "Interrupted",
      reason: systemWarn || "Scan interrupted — resume or start fresh.",
      reasonKind: "interrupted",
      systemWarn,
      primaryCta: "force_rescan",
      isFailed: false,
      isProcessing: true,
      isEarnedSuccess: false,
      queuePosition,
    };
  }

  if (queueState === "queued" || (ACTIVE_QUEUE.has(queueState) && queueState === "queued")) {
    const reason = queueWaitReason(queuePosition, input.queueSlots);
    return {
      class: "queued",
      uiStatusKind: "processing",
      label: queuePosition != null ? `Processing #${queuePosition}` : "Processing",
      reason,
      reasonKind: "queue",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: true,
      isEarnedSuccess: false,
      queuePosition,
    };
  }

  if (
    queueState === "running" ||
    runStatus === "in_progress" ||
    prStatus === "In Progress"
  ) {
    return {
      class: "processing",
      uiStatusKind: "processing",
      label: queuePosition != null ? `Processing #${queuePosition}` : "Processing",
      reason:
        queuePosition != null
          ? `Scan running (queue #${queuePosition}).`
          : "Scan is admitted or running.",
      reasonKind: "queue",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: true,
      isEarnedSuccess: false,
      queuePosition,
    };
  }

  if (blockedGate || persistedClass === "gate_blocked") {
    const gate = blockedGate || "gate";
    return failedOutcome(
      "gate_blocked",
      "gate",
      systemWarn || `Blocked at ${gate}. Fix the gate, then re-scan.`,
      systemWarn,
      "rescan",
    );
  }

  // Explicit persisted / live class
  if (
    persistedClass === "hard_fail" ||
    persistedClass === "quality_failure" ||
    persistedClass === "transport_failure" ||
    persistedClass === "infrastructure_failure" ||
    persistedClass === "unknown_failure"
  ) {
    const kind: ScanTerminalReasonKind =
      persistedClass === "transport_failure"
        ? "transport"
        : persistedClass === "infrastructure_failure"
          ? "infrastructure"
          : persistedClass === "unknown_failure"
            ? "unknown"
            : "quality";
    return failedOutcome(
      persistedClass as ScanTerminalClass,
      kind,
      systemWarn || defaultReason(persistedClass as ScanTerminalClass),
      systemWarn,
    );
  }

  const emptyDiffNoAi =
    !!systemWarn &&
    lower(systemWarn).includes("no code changes detected");

  if (
    persistedClass === "skipped" ||
    runOutcome === "skipped" ||
    usedModel === "none (skipped)" ||
    emptyDiffNoAi
  ) {
    return {
      class: "skipped",
      uiStatusKind: "completed",
      label: emptyDiffNoAi && runOutcome !== "skipped" ? "Completed" : "Skipped",
      reason: systemWarn || "Review skipped (trivial/empty diff) — not an AI pass.",
      reasonKind: "skipped",
      systemWarn,
      primaryCta: "rescan",
      isFailed: false,
      isProcessing: false,
      isEarnedSuccess: false,
      queuePosition: null,
    };
  }

  if (persistedClass === "success") {
    return {
      class: "success",
      uiStatusKind: "completed",
      label: "Completed",
      reason: systemWarn || "Scan finished with an earned AI verdict.",
      reasonKind: "success",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: false,
      isEarnedSuccess: true,
      queuePosition: null,
    };
  }

  // Live ScanResult path (HTTP body before/without persistence)
  if (input.success === false) {
    if (input.infrastructureFailure) {
      return failedOutcome(
        "infrastructure_failure",
        "infrastructure",
        systemWarn || "Infrastructure failure during scan.",
        systemWarn,
      );
    }
    const fromWarn = reasonFromWarn(systemWarn);
    if (fromWarn) {
      return failedOutcome(fromWarn.class, fromWarn.kind, systemWarn || defaultReason(fromWarn.class), systemWarn);
    }
    if (allProvidersQualityOrEmpty(input.providerOutcomes)) {
      const cls =
        (input.providerOutcomes?.filter((o) => o === "quality_failure").length ?? 0) >= 2
          ? "hard_fail"
          : "quality_failure";
      return failedOutcome(cls, "quality", systemWarn || defaultReason(cls), systemWarn);
    }
    if (hasProviderOutcome(input.providerOutcomes, "transport_failure")) {
      return failedOutcome(
        "transport_failure",
        "transport",
        systemWarn || "Transport failure exhausted the provider chain.",
        systemWarn,
      );
    }
    return failedOutcome(
      "hard_fail",
      "unknown",
      systemWarn || "Scan failed without an earned AI verdict.",
      systemWarn,
    );
  }

  // Failed lifecycle (PR or run)
  if (prStatus === "Failed" || runStatus === "failed" || queueState === "failed") {
    const fromWarn = reasonFromWarn(systemWarn);
    if (fromWarn) {
      return failedOutcome(fromWarn.class, fromWarn.kind, systemWarn || defaultReason(fromWarn.class), systemWarn);
    }
    if (allProvidersQualityOrEmpty(input.providerOutcomes)) {
      const qCount = input.providerOutcomes?.filter((o) => o === "quality_failure").length ?? 0;
      const cls = qCount >= 2 ? "hard_fail" : "quality_failure";
      return failedOutcome(cls, "quality", systemWarn || defaultReason(cls), systemWarn);
    }
    if (hasProviderOutcome(input.providerOutcomes, "transport_failure")) {
      return failedOutcome(
        "transport_failure",
        "transport",
        systemWarn || "Transport failure — check network/API keys, then re-scan.",
        systemWarn,
      );
    }
    return failedOutcome(
      "hard_fail",
      "unknown",
      systemWarn || "Last scan did not finish successfully. Re-scan when ready.",
      systemWarn,
    );
  }

  // Completed run: earned only when rating is non-null (or skipped handled above).
  // Require an actual run status (or persisted class) before treating null
  // rating as quality failure — bare PR.status=Completed with no run is
  // legacy/empty and stays pending/completed without a false Failed banner.
  const hasTerminalRun =
    runStatus === "completed" ||
    runStatus === "failed" ||
    !!persistedClass ||
    input.runOutcome != null;

  if (runStatus === "completed" || ((prStatus === "Completed" || prStatus === "scanned") && hasTerminalRun)) {
    if (input.rating == null || !Number.isFinite(input.rating)) {
      // Quiet null rating after AI attempt must not look like a clean pass.
      const fromWarn = reasonFromWarn(systemWarn);
      const cls = fromWarn?.class ?? "quality_failure";
      const kind = fromWarn?.kind ?? "quality";
      return failedOutcome(
        cls,
        kind,
        systemWarn ||
          "Scan finished without a usable rating — not an earned AI pass. Re-scan.",
        systemWarn,
      );
    }
    return {
      class: "success",
      uiStatusKind: "completed",
      label: "Completed",
      reason: systemWarn || "Scan finished with an earned AI verdict.",
      reasonKind: "success",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: false,
      isEarnedSuccess: true,
      queuePosition: null,
    };
  }

  if (prStatus === "Completed" || prStatus === "scanned") {
    return {
      class: "success",
      uiStatusKind: "completed",
      label: "Completed",
      reason: "Scan finished. Check the rating chip for merge readiness.",
      reasonKind: "success",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: false,
      isEarnedSuccess: input.rating != null && Number.isFinite(input.rating),
      queuePosition: null,
    };
  }

  if (prStatus === "Merged") {
    return {
      class: "success",
      uiStatusKind: "merged",
      label: "Merged",
      reason: "Branch is merged on the remote.",
      reasonKind: "none",
      systemWarn,
      primaryCta: "none",
      isFailed: false,
      isProcessing: false,
      isEarnedSuccess: false,
      queuePosition: null,
    };
  }

  return {
    class: "pending",
    uiStatusKind: "pending",
    label: "Pending",
    reason: "Waiting to enter the scan queue.",
    reasonKind: "none",
    systemWarn,
    primaryCta: "none",
    isFailed: false,
    isProcessing: false,
    isEarnedSuccess: false,
    queuePosition: null,
  };
}

function defaultReason(cls: ScanTerminalClass): string {
  switch (cls) {
    case "quality_failure":
      return "Quality failure — model did not produce a usable submitReview. Re-scan or try Force.";
    case "hard_fail":
      return "Hard fail — primary and secondary providers could not produce a verdict. Re-scan.";
    case "transport_failure":
      return "Transport failure — check network/API keys, then re-scan.";
    case "infrastructure_failure":
      return "Infrastructure failure during scan. Check server logs, then re-scan.";
    case "gate_blocked":
      return "Blocked by a prelude gate. Fix the gate, then re-scan.";
    default:
      return "Scan failed without an earned AI verdict. Re-scan when ready.";
  }
}

/**
 * Map a live ScanResult (+ optional queue) into the terminal contract for
 * HTTP responses and immediate UI updates.
 */
export function outcomeFromScanResult(input: {
  success: boolean;
  rating?: number | null;
  systemWarn?: string | null;
  infrastructureFailure?: boolean | null;
  interrupted?: boolean | null;
  usedModel?: string | null;
  providerOutcomes?: Array<string | null | undefined> | null;
  blockedGate?: string | null;
  queueState?: string | null;
  queuePosition?: number | null;
  queueSlots?: ScanTerminalInput["queueSlots"];
}): ScanTerminalOutcome {
  return classifyScanTerminalOutcome({
    success: input.success,
    rating: input.rating,
    systemWarn: input.systemWarn,
    infrastructureFailure: input.infrastructureFailure,
    interrupted: input.interrupted,
    usedModel: input.usedModel,
    providerOutcomes: input.providerOutcomes,
    blockedGate: input.blockedGate,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
    queueSlots: input.queueSlots,
    // Soft-fail without explicit PR status still classifies via success:false.
    prStatus: input.interrupted
      ? "In Progress"
      : input.success
        ? input.usedModel === "none (skipped)"
          ? "Completed"
          : input.rating == null
            ? "Failed"
            : "Completed"
        : "Failed",
    runStatus: input.interrupted
      ? "interrupted"
      : input.success
        ? input.usedModel === "none (skipped)"
          ? "completed"
          : input.rating == null && input.usedModel !== "none (skipped)"
            ? "failed"
            : "completed"
        : "failed",
    runOutcome:
      input.usedModel === "none (skipped)"
        ? "skipped"
        : input.success && input.rating != null
          ? "reviewed"
          : null,
  });
}

/** Extract provider outcome strings from ReviewRun.tokensUsed JSON. */
export function providerOutcomesFromTokensUsed(tokensUsed: unknown): string[] {
  if (!tokensUsed || typeof tokensUsed !== "object") return [];
  const providers = (tokensUsed as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers
    .map((p) =>
      p && typeof p === "object" && "outcome" in p
        ? String((p as { outcome: unknown }).outcome ?? "")
        : "",
    )
    .filter(Boolean);
}

/**
 * PR.status that should be written for a classified terminal outcome.
 * Processing/queued leave lifecycle to the admit path.
 */
export function prStatusForTerminal(outcome: ScanTerminalOutcome): "Completed" | "Failed" | null {
  if (outcome.isProcessing) return null;
  if (outcome.class === "skipped" || outcome.isEarnedSuccess) return "Completed";
  if (outcome.isFailed) return "Failed";
  return null;
}

/** ReviewRun lifecycle + classification to persist. */
export function runPersistForTerminal(outcome: ScanTerminalOutcome): {
  status: "completed" | "failed";
  outcome: "reviewed" | "skipped" | null;
  terminalClass: ScanTerminalClass;
} {
  if (outcome.class === "skipped") {
    return { status: "completed", outcome: "skipped", terminalClass: "skipped" };
  }
  if (outcome.isEarnedSuccess) {
    return { status: "completed", outcome: "reviewed", terminalClass: "success" };
  }
  // Failed classes — including null-rating "completed" mislabel — persist failed.
  return {
    status: "failed",
    outcome: null,
    terminalClass: outcome.isFailed ? outcome.class : "unknown_failure",
  };
}
