# Tasks — Large PR Mode

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/2026-06-27-large-pr-mode/` with plan.md, shape.md, standards.md, references.md, tasks.md.
- [ ] Create standalone `.agent-os/specs/2026-06-27-pr-size-profile/` spec before implementation.
- [ ] Update `roadmap.md` with a Large PR Mode entry under the review-pipeline section.

## Phase 2 — Prerequisites

- [x] **2a:** Ship PR Size Profile first: shared size/profile utility, code-line classifier, API response plumbing, UI chips, and pre-push output. It warns only; it must not block scans.
- [ ] **2b:** Audit `prd.md`, `roadmap.md`, `CLAUDE.md`, code comments for stale `vector(1536)` references; reconcile to current `vector(1024)` schema. Ship as separate one-line doc commit.
- [x] **2c:** Add optional `reviewChunkId?: string` parameter to `runPrScan` signature in `reviewService.ts:326`. No behavior change; existing callers unaffected.
- [x] `npm run lint` clean.
- [x] `npm test` — existing tests pass (backward-compat invariant).

## Phase 3 — Schema migration

- [x] Add `ReviewChunk` model to `prisma/schema.prisma` (after `ReviewRun`, before `PullRequest`).
- [x] Add `reliability`, `chunksTotal`, `chunksCompleted`, `chunksFailed`, `chunksSkipped`, `reviewChunks ReviewChunk[]` to `ReviewRun`.
- [x] Add `reviewChunkId String?` + `@@index([reviewChunkId])` to `ReviewFinding`.
- [x] Add `reviewChunkId String?` + `@@index([reviewChunkId])` to `ReviewLog`.
- [x] Add `securitySensitivePaths String[] @default([])` to `Repository`.
- [x] Run `npx prisma db push` (dev) or generate migration.
- [x] `npm run lint` clean.

## Phase 4 — Diff manifest + tier detection

- [x] Create `src/services/largePrReview/manifest.ts` exporting `buildDiffManifest`, `assertTier`.
- [x] File classification: `code | docs | generated | lock | vendor` (deterministic, no LLM).
- [x] Tier thresholds: `NORMAL_MAX_LINES=800`, `NORMAL_MAX_CODE_FILES=40`, `OVERSIZED_LINES=3000`, `OVERSIZED_CODE_FILES=100`.
- [x] Reuse the PR Size Profile classifier/profile output; do not duplicate the logic.
- [x] Fail-open: malformed input → `tier: "normal"` + logged error, never throws.
- [x] Discriminated union return: `{ ok: true; tier: "normal" | "grouped" | "oversized"; message?: string }`.
- [x] Create `src/services/largePrReview/types.ts` with shared types (`FileClass`, `FileClassification`, `DiffManifest`, `TierResult`, `ChunkPlan`).
- [x] Create `src/services/largePrReview/index.ts` barrel.
- [x] Write `tests/largePrMode/manifest.test.ts` — classification + tier detection + fail-open.
- [x] `npm run lint` clean.

## Phase 5 — Chunker

- [x] Create `src/services/largePrReview/chunker.ts` exporting `chunkDiff`.
- [x] Algorithm priority order: monorepo package boundary → file type bucket → 600-line cap.
- [x] Recursive split when (package, type) bucket exceeds 600 lines; sort by directory prefix, partition at cap.
- [ ] 600-line cap is hard ceiling per chunk. Single huge file → own chunk + log warning (no sub-file splits in v1).
- [x] Determinism: same manifest → same `ChunkPlan[]` (no Map iteration order dependence).
- [x] `touchesSecuritySensitive` computed per chunk via `securitySensitive.ts`.
- [x] Write `tests/largePrMode/chunker.test.ts` — boundary correctness + determinism.
- [x] `npm run lint` clean.

## Phase 6 — Security-sensitive classifier

- [x] Create `src/services/largePrReview/securitySensitive.ts` exporting `isSecuritySensitive`.
- [x] Tier 1: hardcoded `GLOBAL_DEFAULTS` globs (auth, webhooks, crypto, schema, env, etc.).
- [x] Tier 2: hardcoded `KEYWORD_FALLBACK` globs (`**/*auth*`, `**/*crypto*`, etc.). Accept false positives.
- [x] Tier 3: `repoConfiguredPaths` parameter (read from `Repository.securitySensitivePaths`).
- [ ] Glob matching via `picomatch` (verify dependency; add if missing).
- [x] Write `tests/largePrMode/securitySensitive.test.ts` — Tier 1/2/3 matching.
- [x] `npm run lint` clean.

## Phase 7 — Orchestrator

- [x] Create `src/services/largePrReview/orchestrator.ts` exporting `runLargePrReview`.
- [x] State machine: buildDiffManifest → assertTier → chunkDiff → createMany chunks → sequential execution.
- [x] Per chunk: status `pending → running → completed | failed | skipped`.
- [x] Retry once on transient failure (timeout, invalid JSON, network); mark failed on second failure.
- [x] Circuit breaker: 3 consecutive same-error failures → skip remaining chunks (`status: "skipped"`, `skipReason`).
- [x] Lock ownership stays at entry-point route layer; orchestrator try/finally does NOT release lock.
- [x] Update `ReviewRun.chunksCompleted` / `chunksFailed` / `chunksSkipped` counters as each chunk finishes.
- [x] Call `aggregateResults(reviewRunId)` at end.
- [ ] Write `tests/largePrMode/orchestrator.test.ts` — sequential execution, retry-once, circuit breaker.
- [x] `npm run lint` clean.

## Phase 8 — Aggregator

- [x] Create `src/services/largePrReview/aggregator.ts` exporting `aggregateResults`.
- [x] Reliability verdict: `complete` (all completed) | `partial` (some failed/skipped, none security-sensitive) | `incomplete_security_review` (security-sensitive chunk failed/skipped → rating null).
- [x] Final rating: weighted average of completed chunk ratings (weighted by line count, fallback to mean).
- [x] Dedup findings by `(filename, line, category)` — keep highest `confidence`, delete rest.
- [x] Build `skippedReasons` array from `status: "skipped"` chunks.
- [x] **Idempotency:** re-running aggregation produces same `finalRating` (deterministic sort, no `Date.now()` / `Math.random()`).
- [x] Update `ReviewRun` with reliability, counters, final rating, `status: "completed"`, `completedAt`.
- [ ] Write `tests/largePrMode/aggregator.test.ts` — dedup, reliability verdicts, idempotency.
- [x] `npm run lint` clean.

## Phase 9 — Route integration + UI

- [x] **9a:** Insert tier check in `/api/prs/[prId]/scan/route.ts` after `refreshPrFiles`. Route to `runLargePrReview` if `tier === "grouped"` or `tier === "oversized"`; existing flow if `tier === "normal"`.
- [x] **9b:** Insert tier check in `/api/prcheck/[prIdOrNumber]/route.ts`.
- [x] **9c:** Insert tier check in `/api/hooks/prepush/route.ts`.
- [x] **9d:** Insert tier check in `/api/command/[[...args]]/route.ts`.
- [x] **9e:** Create `/api/prs/[prId]/runs/[runId]/retry-failed-chunks/route.ts` — resumes any non-terminal chunk (`status: "failed" | "pending" | "running"`), idempotent. The `running` case covers dev-server restarts mid-scan; existing `completed`/`skipped` chunks are preserved.
- [x] **9f:** Create `src/components/views/prs/LargePrModePanel.tsx` — banner with chunk count, per-chunk progress list, failed-chunk retry button, reliability verdict badge.
- [x] **9g:** Mount `LargePrModePanel` in `ReviewCard.tsx` above findings list, visible when `reviewRun.chunksTotal > 0`.
- [x] **9h:** Add cross-chunk-bugs-may-be-missed disclosure note to panel.
- [x] **9i:** Show Size Profile chip in LargePrModePanel; `oversized` copy says "split recommended" but does not imply the scan was blocked.
- [x] Plumb `reliability` / `chunksTotal` / `chunksCompleted` / `chunksFailed` / `chunksSkipped` through `useDashboardData` → `App.tsx` → `PrsView` → `ReviewCard`.
- [x] `npm run lint` clean.
- [x] `npm run build` succeeds.

## Phase 10 — Tests + final verification

- [ ] Write `tests/largePrMode/chunkBoundary.test.ts` — finding in file A never appears in chunk B's persisted `reviewChunkId` (**chunk-boundary correctness invariant**).
- [ ] Write `tests/largePrMode/e2e.test.ts` — full flow with mocked `runPrScan`: manifest → chunk → run → aggregate → ReviewRun final state.
- [x] `npm run lint` clean.
- [x] `npm test` — all existing tests + new tests pass.
- [x] `npm run build` — production build succeeds.
- [ ] Manual: trigger scan on a synthetic 1200-line PR (e.g., temp feature branch). Confirm Large PR Mode activates, chunks complete, aggregation produces a verdict, UI shows panel.
- [ ] Manual: trigger scan on a synthetic 4000-code-line PR. Confirm `sizeProfile.tier === "oversized"`, Large PR Mode still runs best-effort, and UI says "split recommended."
- [ ] Manual: trigger scan on a PR with a security-sensitive chunk that fails. Confirm `reliability: "incomplete_security_review"`, `rating: null`.
- [ ] Manual: click "Retry failed chunks" button after a killed scan. Confirm resume picks up `failed` + `pending` + stuck `running` chunks; completed/skipped chunks untouched.
