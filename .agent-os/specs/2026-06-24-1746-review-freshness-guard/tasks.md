# Tasks — Review Freshness Guard + v1 Finding Verifier

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [ ] Create `.agent-os/specs/2026-06-24-1746-review-freshness-guard/` with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — Schema migration

- [ ] Add `ReviewRun` model to `prisma/schema.prisma` (after `ReviewHistory`, before `PullRequest`).
- [ ] Add `reviewRunId` FK + `verificationStatus` + `verificationNote` to `ReviewFinding`.
- [ ] Add `reviewRuns ReviewRun[]` relation to `PullRequest`.
- [ ] Create migration `prisma/migrations/<timestamp>_review_runs/migration.sql` with legacy-data synthesis (one legacy ReviewRun per distinct prId with existing findings, `triggerReason: 'legacy'`, empty diffHash/reviewConfigHash).
- [ ] Run `npx prisma generate` + `npx prisma db push`.
- [ ] Verify: `SELECT count(*) FROM review_runs WHERE trigger_reason = 'legacy'` matches distinct PRs with existing findings.
- [ ] `npm run lint` clean.

## Phase 3 — Freshness helpers

- [ ] Create `src/lib/reviewFreshness.ts` exporting `computeDiffHash`, `computeReviewConfigHash`, `assertReviewFreshness`, `createReviewRun`.
- [ ] Mirror discriminated-union shape from `assertIndexFresh`.
- [ ] Fail-open: never throw on malformed input; return sentinel hash + NO_RUN.
- [ ] `npm run lint` clean.

## Phase 4 — Scan route short-circuit

- [ ] Move `refreshPrFiles` call in `src/app/api/prs/[prId]/scan/route.ts` to before freshness check.
- [ ] Compute `currentDiffHash` from `refreshPrFiles` output.
- [ ] Compute `currentConfigHash` from `getChatChain()` + system prompt hash.
- [ ] Check `force=true` query param; bypass cache if set.
- [ ] Short-circuit: if matching completed ReviewRun exists, return `200 { cached: true, runId, findings }`.
- [ ] Otherwise: create `in_progress` ReviewRun via `createReviewRun`, pass `reviewRunId` into `runPrScan`.
- [ ] Update `/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command/[[...args]]` callers to create ReviewRun + pass ID.
- [ ] `npm run lint` clean.

## Phase 5 — v1 Finding Verifier

- [ ] Create `src/services/findingVerifier.ts` with `verifyFindings` function.
- [ ] Stage A: line/file validation (file exists, line in bounds, code at line matches claim) for all findings.
- [ ] Stage B: counter-evidence retrieval for auth, data-isolation, webhook/network, concurrency categories.
- [ ] LLM-assisted verdict via `getChatChain()[0]` for Stage B cases.
- [ ] Parse LLM response; fall back to `unverified` on failure.
- [ ] Never throw — wrap everything in try/catch, return `unverified` on any exception.
- [ ] `npm run lint` clean.

## Phase 6 — Wire verifier + ReviewRun lifecycle into runPrScan

- [ ] Change `runPrScan` signature to accept `reviewRunId: string` as third arg.
- [ ] Call `verifyFindings` after candidate generation, before persistence.
- [ ] Persist `verificationStatus` + `verificationNote` on each finding row.
- [ ] Add `reviewRunId` to each persisted finding.
- [ ] On success: `reviewRun.update` to `status: 'completed'` + `rating` + `completedAt`.
- [ ] On failure: `reviewRun.update` to `status: 'failed'` + `completedAt`.
- [ ] `npm run lint` clean.
- [ ] `npm test` — existing tests pass.

## Phase 7 — Findings route + UI

- [ ] Rewrite `GET /api/prs/[prId]/findings` to filter by latest completed ReviewRun.
- [ ] Exclude `verificationStatus: 'rejected'` findings from main response.
- [ ] Return `rejectedCount` for UI badge.
- [ ] Compute current `diffHash` from PR files; return `stale` flag if mismatch.
- [ ] Update `ReviewCard.tsx`: "Reviewed commit: abc1234" badge + relative timestamp.
- [ ] Add amber `⚠ stale` chip when `reviewRun.stale === true`.
- [ ] Add collapsible "Verifier filtered: N findings" `<details>` section.
- [ ] Add per-finding chip showing `verificationStatus` when not `verified`.
- [ ] `npm run lint` clean.
- [ ] `npm run build` succeeds.

## Phase 8 — Tests + final verification

- [ ] Write `tests/reviewFreshness.test.ts` — `computeDiffHash` stability across input reordering.
- [ ] Write `tests/findingVerifier.test.ts` — fixture findings citing non-existent files → rejected.
- [ ] Write `tests/scanCache.test.ts` — integration: scan → re-scan with no changes → second call short-circuits.
- [ ] `npm run lint` clean.
- [ ] `npm test` — all tests pass (existing 55 + new).
- [ ] `npm run build` — production build succeeds.
- [ ] Manual: clear findings for `feature/bug-demo`, refresh files, re-scan. Confirm the 3 false-positive blockers are rejected or absent.
- [ ] Manual: re-scan with no changes → cached 200, no LLM cost.
- [ ] Manual: UI shows "Reviewed commit: …" badge + collapsible verifier section.
- [ ] Commit each phase individually per the user's `git add .` convention.
