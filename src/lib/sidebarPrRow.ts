/**
 * Layout-C sidebar PR row presenters (pure).
 *
 * Expanded repo PR list:
 *   - title
 *   - `PR #N · issue #M` when known
 *   - compact status + rating oblong pills (same presenters as header)
 *
 * Rating pill shown when completed (incl. no score) or when a score exists.
 * Native title tooltips only — no help cursor.
 */

import {
  formatPrIdentity,
  type PrIdentityInput,
} from "./prIdentity";
import {
  presentRatingPill,
  presentStatusPill,
  type LayoutCPillTone,
  type LayoutCRatingPill,
  type LayoutCStatusPill,
  type PresentStatusPillInput,
} from "./layoutCPills";

/** Tailwind classes for layout-C oblong pills (compact sidebar size). */
const TONE_CLASS: Record<LayoutCPillTone, string> = {
  amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  blue: "bg-sky-500/10 text-sky-300 border-sky-500/35",
  green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  red: "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

const COMPACT_PILL_BASE =
  "px-1.5 py-0 text-[8px] rounded-full uppercase font-mono font-bold border inline-flex items-center gap-1 leading-none";

export type SidebarPrRowInput = PrIdentityInput &
  PresentStatusPillInput & {
    rating?: number | null;
  };

export type SidebarPrRowView = {
  title: string;
  /** e.g. "PR #31 · issue #25" — null when neither number is known. */
  identityLine: string | null;
  githubPrNumber: number | null;
  ticketNumber: number | null;
  status: LayoutCStatusPill;
  /** Present when completed/scanned or a numeric rating exists (incl. no score on completed). */
  rating: LayoutCRatingPill | null;
  showRating: boolean;
};

/**
 * Compact identity under the title: `PR #N · issue #M` (parts only when known).
 */
export function formatSidebarPrIdentityLine(input: PrIdentityInput): string | null {
  const id = formatPrIdentity(input);
  const parts: string[] = [];
  if (id.githubPrNumber != null) parts.push(`PR #${id.githubPrNumber}`);
  if (id.ticketNumber != null) parts.push(`issue #${id.ticketNumber}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Whether the rating oblong should appear on the sidebar row.
 * Matches prototype: completed (incl. no score) or any known rating.
 */
export function shouldShowSidebarRatingPill(
  status: string,
  rating: number | null | undefined,
): boolean {
  const s = (status ?? "").trim();
  if (s === "Completed" || s === "scanned") return true;
  if (rating != null && Number.isFinite(rating)) return true;
  return false;
}

/** Map layout-C tone → compact oblong pill className (no cursor-help). */
export function layoutCCompactPillClassName(tone: LayoutCPillTone): string {
  return `${COMPACT_PILL_BASE} ${TONE_CLASS[tone]}`;
}

/**
 * Full sidebar PR row view-model from production PR fields.
 */
export function presentSidebarPrRow(input: SidebarPrRowInput): SidebarPrRowView {
  const identity = formatPrIdentity(input);
  const status = presentStatusPill({
    status: input.status,
    queueState: input.queueState,
    queuePosition: input.queuePosition,
  });
  const showRating = shouldShowSidebarRatingPill(input.status, input.rating);
  const rating = showRating ? presentRatingPill(input.rating) : null;

  return {
    title: identity.title,
    identityLine: formatSidebarPrIdentityLine(input),
    githubPrNumber: identity.githubPrNumber,
    ticketNumber: identity.ticketNumber,
    status,
    rating,
    showRating,
  };
}
