/**
 * Layout-C PR identity presenters (pure).
 *
 * Contract (from prototype):
 *   GitHub PR: #{githubPrNumber} — {title}
 *   GitHub Issue: #{ticketNumber} — {sourceBranch}
 *
 * Ticket/issue only when reliably known; never invent.
 * No ticket → no empty Issue line; branch fallback only.
 */

export type PrIdentityInput = {
  title: string;
  sourceBranch: string;
  /** GitHub pull request number when the API has it; null/undefined when unknown. */
  githubPrNumber?: number | null;
  /**
   * Explicit ticket/issue number. When omitted, may be derived from sourceBranch.
   * Pass null to suppress branch-derived tickets (never invent).
   */
  ticketNumber?: number | null;
};

export type PrIdentityLines = {
  /** e.g. "GitHub PR: #30 — Title" or "GitHub PR: — Title" when number unknown. */
  prLine: string;
  /** Present only when ticket known. e.g. "GitHub Issue: #24 — ticket-24-promote". */
  issueLine: string | null;
  /** Branch alone when no ticket — never an empty Issue line. */
  branchFallback: string | null;
  githubPrNumber: number | null;
  ticketNumber: number | null;
  title: string;
  sourceBranch: string;
};

/**
 * Parse a ticket/issue number from a branch name when the marker is reliable
 * (segment `ticket-<digits>`). Returns null rather than guessing.
 */
export function ticketNumberFromBranch(branch: string): number | null {
  if (!branch) return null;
  const match = branch.match(/(?:^|\/)ticket-(\d+)(?=-|\/|$)/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function resolveTicketNumber(input: PrIdentityInput): number | null {
  if (input.ticketNumber === null) return null;
  if (typeof input.ticketNumber === "number" && Number.isFinite(input.ticketNumber)) {
    return input.ticketNumber > 0 ? input.ticketNumber : null;
  }
  return ticketNumberFromBranch(input.sourceBranch);
}

/**
 * Pure identity formatter for the layout-C two-line contract.
 */
export function formatPrIdentity(input: PrIdentityInput): PrIdentityLines {
  const title = input.title ?? "";
  const sourceBranch = input.sourceBranch ?? "";
  const githubPrNumber =
    typeof input.githubPrNumber === "number" && Number.isFinite(input.githubPrNumber)
      ? input.githubPrNumber
      : null;
  const ticketNumber = resolveTicketNumber(input);

  const prLine =
    githubPrNumber != null
      ? `GitHub PR: #${githubPrNumber} — ${title}`
      : `GitHub PR: — ${title}`;

  if (ticketNumber != null) {
    return {
      prLine,
      issueLine: `GitHub Issue: #${ticketNumber} — ${sourceBranch}`,
      branchFallback: null,
      githubPrNumber,
      ticketNumber,
      title,
      sourceBranch,
    };
  }

  return {
    prLine,
    issueLine: null,
    branchFallback: sourceBranch || null,
    githubPrNumber,
    ticketNumber: null,
    title,
    sourceBranch,
  };
}
