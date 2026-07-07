import { runGitInRepo, type RepoLike } from "./repoAccess";

/**
 * Index freshness gate.
 *
 * Two failure modes:
 *   - INDEX_REQUIRED: repo.indexedAt is null — the codebase has never been
 *     indexed. Reviews against an un-indexed repo produce diff-only LLM
 *     guesses with no call-graph or semantic context.
 *   - STALE_INDEX: indexedAt is non-null but the working-tree HEAD has
 *     moved on since indexing (lastCommitHash differs from current HEAD).
 *     Reviews run against stale symbols/edges — findings may reference
 *     code that no longer exists.
 *
 * `lastCommitHash` is populated by IndexingService on every successful
 * run. Existing repos indexed before this field was added have empty
 * `lastCommitHash` — the stale check is skipped for those rows (treated
 * as fresh) until the next reindex.
 *
 * Git failures (not a git repo, git binary missing, etc.) are swallowed
 * and treated as "can't verify, trust indexedAt" — never block scans on
 * git errors.
 *
 * Repo access: this module supports both legacy (local-path) and
 * remote-volume modes via `runGitInRepo`. For remote-volume repos, the
 * HEAD is read from the cloned volume; if the volume isn't yet cloned,
 * we treat that as "can't verify" (return ok) so the scan can proceed
 * — the fresh-clone + index on first scan handles staleness anyway.
 */

export type Freshness =
  | { ok: true }
  | { ok: false; kind: "INDEX_REQUIRED" | "STALE_INDEX"; message: string };

export interface RepoForFreshness extends RepoLike {
  name: string;
  indexedAt?: string | null;
  lastCommitHash?: string;
}

/**
 * Returns the current HEAD commit hash of the repo, or null if the
 * path isn't a git repo / git is unavailable.
 *
 * Uses `runGitInRepo` so it works for both local-path (legacy) and
 * remote-volume (target) repos. For remote-volume mode, the caller is
 * responsible for ensuring the volume is cloned — otherwise `runGitInRepo`
 * returns a non-zero exit which we treat as "can't read, skip".
 */
export async function currentHeadCommit(repo: RepoLike): Promise<string | null> {
  const { stdout, exitCode } = await runGitInRepo(repo, ["rev-parse", "HEAD"], {
    timeoutMs: 5000,
  });
  if (exitCode !== 0) return null;
  const hash = stdout.trim();
  return /^[0-9a-f]{7,40}$/i.test(hash) ? hash : null;
}

export async function assertIndexFresh(repo: RepoForFreshness): Promise<Freshness> {
  if (!repo.indexedAt) {
    return {
      ok: false as const,
      kind: "INDEX_REQUIRED",
      message: `Project "${repo.name}" has not been indexed yet. Index it first via the dashboard (Codebase AST graph tab → Index Now) or POST /api/repos/${repo.id}/index, then retry.`,
    };
  }

  if (!repo.path && !repo.cloneUrl) {
    return { ok: true as const };
  }
  if (!repo.lastCommitHash) {
    return { ok: true as const };
  }

  const head = await currentHeadCommit(repo);
  if (!head) {
    return { ok: true as const };
  }

  if (head !== repo.lastCommitHash) {
    return {
      ok: false as const,
      kind: "STALE_INDEX",
      message: `Index is stale — indexed at ${repo.lastCommitHash.slice(0, 7)}, working tree HEAD is now ${head.slice(0, 7)}. Reindex before reviewing for current context.`,
    };
  }

  return { ok: true as const };
}
