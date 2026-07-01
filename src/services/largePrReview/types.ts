import type { PrSizeProfile } from "@/src/lib/prSizeProfile";

export type FileClass = "code" | "docs" | "generated" | "lock" | "vendor";
export type LargePrTier = "normal" | "grouped" | "oversized";
export type ChunkStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type ReviewReliability = "complete" | "partial" | "incomplete_security_review";

export interface ReviewFileInput {
  filename: string;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  originalContent?: string | null;
  modifiedContent?: string | null;
  diff?: string | null;
}

export interface FileClassification extends ReviewFileInput {
  additions: number;
  deletions: number;
  lineCount: number;
  fileClass: FileClass;
  packageKey: string;
  typeBucket: string;
}

export interface DiffManifest {
  files: FileClassification[];
  totalLines: number;
  codeLines: number;
  codeFileCount: number;
  docsFileCount: number;
  generatedFileCount: number;
  lockFileCount: number;
  vendorFileCount: number;
  sizeProfile: PrSizeProfile;
  tier: LargePrTier;
  message?: string;
}

export type TierResult =
  | { ok: true; tier: "normal" }
  | { ok: true; tier: "grouped" }
  | { ok: true; tier: "oversized"; message: string };

export interface ChunkPlan {
  id: string;
  label: string;
  files: FileClassification[];
  filePaths: string[];
  lineCount: number;
  touchesSecuritySensitive: boolean;
}

export interface LargePrReviewResult {
  success: boolean;
  /**
   * Phase 4 typed interruption. True when the run was aborted mid-chunk
   * (force-restart, AbortSignal). The orchestrator stops scheduling
   * further chunks; per-chunk resume is Phase 5.
   */
  interrupted?: boolean;
  rating: number | null;
  findings: any[];
  usedModel: string;
  systemWarn?: string | null;
  largePrMode: true;
  tier: LargePrTier;
  reliability: ReviewReliability;
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  chunksSkipped: number;
  warning?: string | null;
}
