/**
 * Shared types for the finding verifier module.
 *
 * Lives here (rather than in `findingVerifier.ts`) so the skeptic pass and
 * absence-claim modules can import the type without dragging in the
 * Prisma/LLM/fs machinery of the parent module. The parent re-exports
 * everything below for back-compat.
 */

export interface CandidateFinding {
  id: string;
  category: string;
  severity: string;
  filename: string;
  line?: number | null;
  explanation: string;
  source?: string | null;
  /** Primary model's confidence in [0, 1]. Absent = skeptic gate passes it. */
  confidence?: number | null;
}

export interface VerificationResult {
  status: "verified" | "downgraded" | "rejected" | "unverified";
  note: string;
}

/**
 * Options for a verification pass.
 *
 *   docsReview — when true, findings citing documentation files
 *                (.md, docs/, .agent-os/, etc.) are NOT auto-rejected.
 *                Set when the scan's explicit purpose is to review docs
 *                (a future scan mode). Default false — normal PR code
 *                reviews treat docs as context, not bug locations.
 */
export interface VerifyOptions {
  docsReview?: boolean;
}
