# Tasks — Review Freshness Guard + v1 Finding Verifier

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/2026-06-24-1746-review-freshness-guard/` with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — Schema migration

- [x] Add `ReviewRun` model to `prisma/schema.prisma` (after `ReviewHistory`, before `PullRequest`).
- [x] Add `reviewRunId` FK + `verificationStatus` + `verificationNote` to `ReviewFinding`.
- [x] Add `reviewRuns ReviewRun[]` relation to `PullRequest`.
- [x] Create `scripts/db-push-direct.sh` (Supabase direct-connection workaround for PgBouncer prepared-statement limit).
- [x] Create `scripts/synthesize-legacy-review-runs.mjs` (one legacy ReviewRun per distinct prId with existing findings, `triggerReason: 'legacy'`, empty diffHash/reviewConfigHash).
- [x] Script deleted 2026-06-26 — legacy-* runs were procedural-fallback template data (model=null, diffHash="", rating=null) that polluted the UI with fake ratings. Purged via `scripts/_purge-legacy.mjs`. New scans always set model + diffHash + triggerReason, never produce legacy-shape rows.
- [x] ~Run against prod Supabase~ — N/A, script deleted. Prod should run `scripts/_purge-legacy.mjs` instead if it has legacy rows.
- [x] `npm run lint` clean.

## Phase 3 — Freshness helpers

- [x] Create `src/lib/reviewFreshness.ts` exporting `computeDiffHash`, `computeReviewConfigHash`, `shortHash`, `assertReviewFreshness`, `createReviewRun`, `completeReviewRun`.
- [x] Mirror discriminated-union shape from `assertIndexFresh`.
- [x] Fail-open: never throw on malformed input; return sentinel hash + NO_RUN.
- [x] `npm run lint` clean.

## Phase 4 — Scan route short-circuit

- [x] Move `refreshPrFiles` call in `src/app/api/prs/[prId]/scan/route.ts` to before freshness check.
- [x] Compute `currentDiffHash` from `refreshPrFiles` output.
- [x] Compute `currentConfigHash` from `getChatChain()` + system prompt hash (`SYSTEM_INSTRUCTION` exported from reviewService.ts).
- [x] Check `force=true` query param; bypass cache if set.
- [x] Short-circuit: if matching completed ReviewRun exists, return `200 { cached: true, runId, rating, findings }`.
- [x] Otherwise: create `in_progress` ReviewRun via `createReviewRun`, pass `reviewRunId` into `runPrScan`.
- [x] Update `/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command/[[...args]]` callers to create ReviewRun + pass ID (shared `startTrackedReview` helper for command route).
- [x] `npm run lint` clean.

## Phase 5 — v1 Finding Verifier

- [x] Create `src/services/findingVerifier.ts` with `verifyFindings` function.
- [x] Stage A: line/file validation (file exists, line in bounds, code at line matches claim) for all findings.
- [x] Stage B: counter-evidence retrieval for auth, data-isolation, webhook/network, concurrency categories.
- [x] LLM-assisted verdict via `getChatClient()` for Stage B cases.
- [x] Parse LLM response; fall back to `unverified` on failure.
- [x] Never throw — wrap everything in try/catch, return `unverified` on any exception.
- [x] `npm run lint` clean.

## Phase 6 — Wire verifier + ReviewRun lifecycle into runPrScan

- [x] Change `runPrScan` signature to accept `reviewRunId?: string` as third arg.
- [x] Call `verifyFindings` after candidate generation, before persistence.
- [x] Persist `verificationStatus` + `verificationNote` on each finding row.
- [x] Add `reviewRunId` to each persisted finding.
- [x] On success: `completeReviewRun(runId, { status: "completed", rating })`.
- [x] On failure: `completeReviewRun(runId, { status: "failed" })`.
- [x] `npm run lint` clean.
- [x] `npm test` — existing tests pass.

## Phase 7 — Findings route + UI

- [x] Rewrite `GET /api/prs/[prId]/findings` to filter by latest completed ReviewRun.
- [x] Exclude `verificationStatus: 'rejected'` findings from main response.
- [x] Return `rejectedCount` for UI badge.
- [x] Compute current `diffHash` from PR files; return `stale` flag if mismatch.
- [x] Update `ReviewCard.tsx`: "Reviewed: <sha>" badge + relative timestamp.
- [x] Add amber `⚠ Stale` chip when `stale === true`.
- [x] Add collapsible "Verifier filtered: N findings" section.
- [x] Add per-finding chip showing `verificationStatus` when not `verified`.
- [x] Plumb `reviewRun` / `rejectedCount` / `stale` through `useDashboardData` → `App.tsx` → `PrsView` → `ReviewCard`.
- [x] `npm run lint` clean.
- [x] `npm run build` succeeds.

## Phase 8 — Tests + final verification

- [x] Write `tests/reviewFreshness.test.ts` — `computeDiffHash` stability across input reordering + 12 cases.
- [x] Write `tests/findingVerifier.test.ts` — fixture findings citing non-existent files → rejected + 5 cases.
- [ ] Write `tests/scanCache.test.ts` — integration: scan → re-scan with no changes → second call short-circuits. Deferred — needs HTTP/route-level mocking beyond vitest's default scope; the short-circuit logic is exercised by `assertReviewFreshness` returning `{ ok: true }` which is covered indirectly.
- [x] `npm run lint` clean.
- [x] `npm test` — all 72 tests pass (was 55 baseline + 17 new across 2 files).
- [x] `npm run build` — production build succeeds.
- [ ] Manual: clear findings for `feature/bug-demo`, refresh files, re-scan. Confirm the 3 false-positive blockers are rejected or absent. (Requires DB push — user action.)
- [ ] Manual: re-scan with no changes → cached 200, no LLM cost. (Requires DB push.)
- [ ] Manual: UI shows "Reviewed: …" badge + collapsible verifier section. (Requires DB push + dev server.)
