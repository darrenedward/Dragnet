import type { PrSizeProfile } from "./prSizeProfile";

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
  webhookEnabled?: boolean;
  lastWebhookEventAt?: string | null;
  runnerImage?: string | null;
  installCommand?: string | null;
  testCommand?: string | null;
  isPollingEnabled?: boolean | null;
  autoRescanPolicy?: "inherit" | "enabled" | "disabled" | null;
  maxConcurrentScans?: number | null;
  skipTier2?: boolean | null;
  apiKeyPrefix?: string | null;
  hostedMode?: boolean | null;
  webhookId?: string | null;
  /**
   * User who created the repo, recorded by `POST /api/repos`. The
   * sidebar splits "Your projects" (where this equals the current
   * user's id) from "Shared with you" (where the current user has a
   * `UserRepo` row but is not the owner). Null for legacy repos that
   * predate #69; the backfill script populates it on first migration.
   */
  ownerId?: string | null;
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
  sizeProfile?: PrSizeProfile;
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
  category: "Security" | "Correctness" | "Performance" | "Accessibility" | "Style";
  severity: "blocker" | "warning" | "suggestion";
  exploitability?: "trivial" | "moderate" | "difficult" | null;
  impact?: "critical" | "high" | "medium" | "low" | null;
  filename: string;
  line: number;
  explanation: string;
  diffSuggestion: string;
  evidenceChain?: string;
  confidence?: number;
  confidenceReason?: string;
  timestamp: string;
  verificationStatus?: "verified" | "downgraded" | "rejected" | "unverified" | null;
  verificationNote?: string | null;
  skepticVerdict?: "confirmed" | "downgraded" | "rejected" | null;
  skepticNote?: string | null;
  source?: string | null;
  isRegression?: boolean;
  regressedFromRunId?: string | null;
}

export interface ReviewChunk {
  id: string;
  label: string;
  filePaths: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped" | string;
  skipReason?: string | null;
  rating?: number | null;
  summary?: string | null;
  errorMessage?: string | null;
  lineCount: number;
  touchesSecuritySensitive: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
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

export interface ConfigHealthItem {
  id: string;
  label: string;
  variables: string[];
  status: "missing" | "invalid";
  severity: "blocking" | "warning";
  feature: string;
  message: string;
  action: string;
  restartRequired: boolean;
}

export interface ConfigHealthReport {
  ok: boolean;
  status: "ok" | "needs_setup";
  summary: string;
  items: ConfigHealthItem[];
  generatedAt: string;
}

export interface LlmPresetView {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  hasApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
  /** Agentic-loop cap for this preset's chat model. Undefined = server default (16). */
  maxIterations?: number;
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

export type ActiveTab = "prs" | "queue" | "watcher" | "roadmap" | "db_config" | "llm_config" | "codebase" | "team";

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
