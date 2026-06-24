export interface Repository {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  activeBranch: string;
  triggerMode: "auto" | "mention";
  quietPeriodSeconds: number;
  branchPattern: string;
  status: "idle" | "detected" | "stabilizing" | "ready" | "reviewing";
  lastCommitHash: string;
  lastCommitMessage: string;
  reviewsCount: number;
  prCount?: number;
  /**
   * ISO timestamp of the last successful indexing run. Null when the repo
   * has never been indexed — UI gates the Scan button on this and the
   * /api/prs/[id]/scan route rejects with 409 INDEX_REQUIRED.
   */
  indexedAt?: string | null;
  provider?: string | null;
  cloneUrl?: string | null;
  cloneUrlHttps?: string | null;
  patCipher?: string | null;
  deployKeyCipher?: string | null;
  localPath?: string | null;
}

export interface PullRequest {
  id: string;
  repoId: string;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  status: string;
  author: string;
  commitHash: string;
  createdAt: string;
  description: string;
  rating?: number | null;
}

export interface PRFile {
  id: string;
  prId: string;
  filename: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  originalContent: string;
  modifiedContent: string;
  diff: string;
}

export interface ReviewFinding {
  id: string;
  prId: string;
  repoId: string;
  category: "Security" | "Correctness" | "Performance" | "Style";
  severity: "blocker" | "warning" | "suggestion";
  filename: string;
  line: number;
  explanation: string;
  diffSuggestion: string;
  evidenceChain?: string;
  confidence?: number;
  timestamp: string;
  verificationStatus?: "verified" | "downgraded" | "rejected" | "unverified" | null;
  verificationNote?: string | null;
}

export interface ActivityLog {
  id: string;
  action: string;
  target: string;
  time: string;
  status: "done" | "pending";
}

export interface DbConfig {
  dialect: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sqliteFile: string;
}

export interface LlmPresetView {
  id: string;
  name: string;
  endpoint: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
}

export interface LlmPresetsState {
  presets: LlmPresetView[];
  /** @deprecated use primaryChatPresetId — kept for backward compat. */
  activeChatPresetId: string;
  /** @deprecated use primaryEmbeddingPresetId — kept for backward compat. */
  activeEmbeddingPresetId: string;
  primaryChatPresetId: string;
  fallbackChatPresetId: string;
  primaryEmbeddingPresetId: string;
  fallbackEmbeddingPresetId: string;
}

export type ActiveTab = "prs" | "watcher" | "roadmap" | "db_config" | "llm_config" | "codebase";

export const getStatusBadgeStyle = (status: string): string => {
  switch (status) {
    case "In Progress":
      return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
    case "Completed":
    case "scanned":
      return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
    case "Failed":
      return "bg-rose-500/10 text-rose-400 border border-rose-500/20";
    case "Pending":
    case "open":
    default:
      return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
  }
};
