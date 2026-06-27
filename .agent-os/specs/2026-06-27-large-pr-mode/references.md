# References for Large PR Mode

## Pattern Implementations

### `reviewLocks.ts` — per-PR concurrency guard

- **Location:** `src/lib/reviewLocks.ts`
- **Relevance:** `acquireReviewLock(prId, force)` is the existing helper used by `/api/prs/[prId]/scan`, `/api/hooks/prepush`, and `/api/prcheck/[prIdOrNumber]`. `runLargePrReview` reuses the same lock so a PR in Large PR Mode can't be concurrently rescanned by any other entry point. No new locking primitive needed.
- **Key patterns to borrow:**
  - `acquireReviewLock(prId, force)` returns discriminated union `{ status: "ok" } | { status: "busy", runId, startedAt, message }`
  - `endReview(prId)` releases the lock — MUST be called in every exit path including catch blocks
  - `force=true` overrides busy state (used by manual retry buttons)

### `findingVerifier.ts` — post-processing pipeline pattern

- **Location:** `src/services/findingVerifier.ts`
- **Relevance:** The verifier already does per-finding post-processing after `runPrScan` candidate generation and before persistence. The Large PR Mode aggregator mirrors this pattern at the run level: per-chunk findings get deduped and tagged with `reliability` before final persistence.
- **Key patterns to borrow:**
  - Verifier returns `Map<string, VerificationResult>` keyed by finding ID — same shape works for chunk-level findings map
  - "Never throws" pattern: wrap everything in try/catch, degrade to `unverified` (here: `partial` reliability) on any exception
  - Per-finding file path resolution via `safeReadFileSync` from `src/lib/pathSafety.ts` — reuse for security-sensitive classification

### `reviewFreshness.ts` — lifecycle helpers + discriminated unions

- **Location:** `src/lib/reviewFreshness.ts`
- **Relevance:** `createReviewRun`, `completeReviewRun`, and `assertReviewFreshness` are the existing helpers that manage the `ReviewRun` lifecycle. The orchestrator calls `createReviewRun` once at the start (already done by entry-point routes), then `completeReviewRun` with the aggregated result at the end.
- **Key patterns to borrow:**
  - `completeReviewRun(runId, { status, rating })` — extend with `reliability`, `chunksCompleted`, `chunksFailed`, `chunksSkipped` fields (requires schema addition)
  - Discriminated union return shape for tier classification
  - sha256 + 16-char hex for hash fields (`diffHash`, etc.) — reuse for `chunkHash` if needed

### `getRealLocalPrs.ts` — diff source + RepoFile shape

- **Location:** `src/lib/getRealLocalPrs.ts:44-52, 243-271`
- **Relevance:** `refreshPrFiles` is the source of the `RepoFile[]` that the diff manifest classifies. `RepoFile` has `{ filename, status, additions, deletions, originalContent, modifiedContent, diff }` — exactly what we need to compute per-file line counts and classify as code/docs/generated.
- **Key patterns to borrow:**
  - `RepoFile` interface (lines 44-52) — input shape for `buildDiffManifest`
  - Comment block at lines 158-162: rationale for NOT wrapping writes in a transaction (apply to chunk row writes)
  - `refreshPrFiles(repoPath, baseBranch, sourceBranch, prId)` — already called by entry-point routes before scanning; orchestrator receives the result

### `indexFreshness.ts` — discriminated-union freshness pattern

- **Location:** `src/lib/indexFreshness.ts:25-85`
- **Relevance:** Canonical pattern for `assertTier` to mirror. Same fail-open philosophy.
- **Key patterns to borrow:**
  - Discriminated union: `{ ok: true } | { ok: false; kind, message }`
  - Fail-open on git errors (lines 71-74): if git fails, return `{ ok: true }` so scan proceeds
  - `execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 5000 })` — no shell, no injection

### `runReaper.ts` — auto-reap orphaned runs

- **Location:** `src/services/runReaper.ts`
- **Relevance:** Existing reaper marks `ReviewRun` rows as `failed` if they've been `in_progress` past a timeout. With Large PR Mode, runs can legitimately be in_progress for 30+ minutes. The reaper's timeout must be raised for chunked runs, OR the reaper must check for live `ReviewChunk` rows before reaping.
- **Key patterns to borrow:**
  - Periodic sweep pattern (probably `setInterval` in `instrumentation.ts`)
  - Distinguish "stuck" from "legitimately long-running" via chunk activity timestamps

### `embeddingService.ts` — circuit breaker pattern

- **Location:** `src/services/embeddingService.ts`
- **Relevance:** The embedding service has a module-level `embeddingCircuitOpen` flag that trips after all providers fail, returning `[]` silently to avoid log spam. The chunk executor could mirror this: if N consecutive chunks fail with the same error, trip a circuit and skip remaining chunks rather than burning budget on a known-bad config.
- **Key patterns to borrow:**
  - `embeddingCircuitOpen` boolean + reset on process restart
  - Single console.error with remediation hint, not per-call spam

## Spec format precedents

### `2026-06-24-1746-review-freshness-guard/` — closest prior spec

- **Location:** `.agent-os/specs/2026-06-24-1746-review-freshness-guard/`
- **Relevance:** Established the `ReviewRun` model that this spec extends. Same shape (Context → Tasks → Verification → Critical files). Shows how to document schema changes, lifecycle helpers, and UI integration as separate phases.
- **Key patterns to borrow:**
  - Phase structure with explicit Files + Pattern + Verify per phase
  - Migration handling notes (synthesizing legacy rows — we'll need an equivalent for back-filling `ReviewChunk` relations on existing runs)
  - Critical files referenced section at the end

### `2026-06-25-1130-scan-quality-and-history-redesign/` — scan-quality spec

- **Location:** `.agent-os/specs/2026-06-25-1130-scan-quality-and-history-redesign/`
- **Relevance:** Closest prior work on scan-quality guarantees. Shows how the team reasons about "honest failure modes" — same philosophy needed for `partial`/`incomplete_security_review` reliability verdicts.

## Triggering incident artifacts

- **PR `feature/bug-demo` at commit `130f5bf`** — 21,053-line diff that broke the agentic loop on 2026-06-27. The branch name literally means "demo the bug hunter" — it accumulated the entire MVP build-up (125 commits) and was never a real merge candidate.
- **Failed `ReviewRun` `run-b35b6509-3474-4250-87b7-32ca21b0cf17`** — Minimax-M3 exhausted 16 iterations without `submitReview`; Z.ai Flash fallback also failed. Direct evidence that the existing single-pass flow can't handle oversized diffs.

## PRD / roadmap references

- **`prd.md` §14** — review pipeline section; Large PR Mode is a new subsection, not a modification of existing §14.6 verifier or §14.7 ReviewPass.
- **`roadmap.md`** — no existing Large PR Mode entry; this spec adds one. Roadmap update is part of Task 1 (spec documentation phase).

## What NOT to reference

- **Don't** reach for the call-graph (`Symbol`/`Edge` tables) in v1. The chunker uses directory structure only. Call-graph-aware chunking is explicitly v2.
- **Don't** reach for `getRealLocalPrs.getRealLocalPrs` (the git-remote variant). Large PR Mode operates on the already-computed `RepoFile[]` from `refreshPrFiles`, not on a fresh git fetch.
