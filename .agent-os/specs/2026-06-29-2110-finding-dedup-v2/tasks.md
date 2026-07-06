# Tasks — Finding dedup v2

Update status as work progresses. Mark each `[x]` only when the work is actually done.

## GitHub Issues

| # | Title | Status |
|---|-------|--------|
| #19 | Dedup PR4: Regression Detection — flag resurfaced findings | `ready-for-agent` |
| #18 | Dedup PR5: Stability Score — compute convergence readiness | `ready-for-agent` |
| #20 | Dedup PR6: Rating Calibration by Model Tier — trust-weighted stability | `ready-for-agent` |

## PR1 — Intra-run symbol-anchored dedup (DONE in a6a1ee4)

### Piece 1 — fingerprint helper

- [x] 1.1 New file `src/services/largePrReview/fingerprint.ts` (~95 lines):
  - `buildFindingFingerprint({ symbolId?, filePath, category })` — pure function. Returns `sym:${symbolId}:${category}` when symbolId present, else `pos:${filePath}:${category}`. Hash with `node:crypto` sha256, hex, first 16 chars.
  - `resolveSymbolForFinding(repoId, filePath, line)` — single `prisma.symbol.findFirst` using existing compound index. `orderBy: { lineStart: "desc" }` to pick tightest match on overlap.
  - `resolveSymbolsBatch(repoId, points[])` — single `prisma.symbol.findMany` covering all `(filePath, line)` pairs in a run, then in-memory filter for containment + tightest-match. Avoids N+1.
- [x] 1.2 Barrel export added to `src/services/largePrReview/index.ts`.

### Piece 2 — swap dedupFindings

- [x] 2.1 In `src/services/largePrReview/aggregator.ts:125-159`: replaced positional key with `buildFindingFingerprint` output. `resolveSymbolsBatch` runs once per run, builds `Map<findingKey, symbolId>`, fingerprints computed in-memory.
- [x] 2.2 Existing tiebreaker preserved (highest confidence → earliest timestamp) — only the key changed.

### Piece 3 — tests

- [x] 3.1 New `tests/largePrMode/fingerprint.test.ts` (8 tests, pure-function only — no prisma mocking). Covers: determinism, symbol-anchored grouping across files, distinct symbols in same file don't collide, distinct categories on same symbol don't collide, fallback path when symbolId missing, fallback distinguishes files, symbol-anchored vs fallback don't collide, 16-char hex format.

### Piece 4 — ship

- [x] 4.1 `npm run lint` (tsc --noEmit) clean.
- [x] 4.2 `npx vitest run` — full suite green (193/193, baseline 185 + 8 new).
- [x] 4.3 Committed on `main` as `a6a1ee4` — 4 files changed, 241 insertions, 4 deletions. Well under 500-line budget.

## PR2 — Cross-run fingerprint + status tracking (DONE in 4ec53b2)

### Piece 5 — schema migration

- [x] 5.1 Add to `ReviewFinding` (`prisma/schema.prisma:179`): `fingerprint String?`, `firstSeenRunId String?`, `lastSeenRunId String?`, `resolvedAtRunId String?`, `status String?` ("open"|"resolved"|"wontfix"). Plus `sourceHashAtInsert String?` to snapshot code state at detection time (added during impl — needed to distinguish "fixed" from "detection regression").
- [x] 5.2 Index `@@index([prId, status])` added (covers the reconcile query; `(prId, status, fingerprint)` was over-specified — fingerprint matching is in-memory).
- [x] 5.3 `npx prisma db push` applied to dev DB.

### Piece 6 — compute + persist fingerprint at insert

- [x] 6.1 `reviewService.ts:1084-1110`: `findingsData` now includes `fingerprint`, `firstSeenRunId`, `lastSeenRunId: reviewRunId`, `status: "open"`, `sourceHashAtInsert`. Symbol resolution batched via `resolveSymbolsBatch`.

### Piece 7 — reconcile across runs

- [x] 7.1 New `src/services/largePrReview/reconcile.ts` (~190 lines including pure-function core + DB wrapper): `reconcileFindingsAcrossRuns(prId, currentRunId)`.
- [x] 7.2 Logic implemented: load current run's open findings; load prior open findings for this PR; match by fingerprint. Match → bump prior `lastSeenRunId` + refresh `sourceHashAtInsert`, delete new duplicate. Defense-in-depth: a single current finding can't match two priors (`currentByFp.delete` after match).
- [x] 7.3 Missing prior findings: resolve current `symbol.sourceHash`, compare to `prior.sourceHashAtInsert`. Changed → `status=resolved`. Unchanged → log `[dedup]` warning, leave open.
- [x] 7.4 Called from BOTH paths: `aggregator.ts` (large PRs, after `dedupFindings`) AND `reviewService.ts:1116` (normal PRs, in the `if (reviewRunId && !reviewChunkId)` block before `completeReviewRun`).

### Piece 8 — skill output filtering

- [x] 8.1 `src/app/api/command/[[...args]]/route.ts:480-529`: filters findings to `status !== "resolved"` (null-status legacy rows stay visible for back-compat).
- [x] 8.2 Tests `tests/largePrMode/reconcileFindings.test.ts` — 9 pure-function tests covering `planReconcile` (match/mismatch/multiple/null-fp/double-match defense/empty).

### Piece 8 — ship

- [x] 8.3 `npm run lint` clean.
- [x] 8.4 `npx vitest run` — full suite 202/202 (baseline 193 + 9 new reconcile).
- [x] 8.5 Committed on `main` as `4ec53b2` — 8 files, 389 insertions, 15 deletions.

## PR3 — Skill trend rendering (DONE in e6c82e3)

### Piece 9 — extend prcheckstatus

- [x] 9.1 `src/lib/reviewFreshness.ts`: added `getRecentRuns(prId, limit=5)` at end of file (placed there to avoid merge conflict with user's pre-existing `getActiveScan` mod). Returns last 5 completed runs, ascending order.
- [x] 9.2 `src/app/api/command/[[...args]]/route.ts:516-528`: `ratingTrend` array added to response, alongside `reviewRun`.

### Piece 10 — skill spec

- [x] 10.1 `.claude/skills/dragnet/SKILL.md`: documented `ratingTrend` field in the completed-response shape + added "Rating trend rendering" subsection with format `📈 Trend: R1: 3/10 → R2: 5/10 → R3: 7/10 ← current` and the "skip if <2 entries" rule.
- [x] 10.2 Synced to `~/.claude/skills/dragnet/SKILL.md`.

### Piece 11 — ship

- [x] 11.1 `npm run lint` clean.
- [x] 11.2 `npx vitest run` — full suite 202/202.
- [x] 11.3 Committed on `main` as `e6c82e3` — 3 files, 52 insertions. (Bundled user's pre-existing `prId`-on-`getActiveScan` mod per their request.)

## Blockers / open questions

- **PR2 Piece 7.3 (resolved):** used `sourceHashAtInsert` snapshot per finding (not the original "Symbol.sourceHash on row" idea) — required adding one extra column to the schema but gives accurate fixed-vs-regression classification.
- **PR3 single-run PRs:** trend line omitted when `ratingTrend.length < 2` per spec.
- **Follow-up (out of scope):** LLM semantic-matching tiebreaker for ambiguous fingerprint cases. Ship symbol-anchored first; revisit if real-world miss-rate is high.
- **Follow-up (out of scope):** `--history` flag on `/dragnet status` to surface resolved findings. Default-hidden per user preference; add when explicitly requested.

## Blockers / open questions

- PR2 Piece 7.3: how to detect "code changed at anchor" cheaply — use `Symbol.sourceHash` (already on the row) vs full diff. `sourceHash` is cheaper; defer full-diff approach unless sourceHash proves unreliable.
- PR3: when fewer than 2 prior runs exist, omit the trend line (no value in showing "R1: 7/10" alone).

## PR4 — Regression detection (DONE in 8d9e8be — Issue #19)

### Piece 12 — schema + detection

- [x] 12.1 `prisma/schema.prisma:179` ReviewFinding: add `isRegression Boolean @default(false)`, `regressedFromRunId String?`. `npx prisma db push`.
- [x] 12.2 In `src/services/largePrReview/reconcile.ts`: after resolving prior findings, walk current run's new findings. For each, if a prior finding on the same fingerprint was marked `resolved` in this run AND `prior.sourceHashAtInsert !== current.symbol.sourceHash` → set `isRegression=true`, `regressedFromRunId=priorRunId`.
- [x] 12.3 Extract pure function `detectRegressions(currentNew, priorResolved, symbolHashesNow): RegressionPlan` — unit-testable, no DB.
- [x] 12.4 Tests `tests/largePrMode/detectRegressions.test.ts`: regression flagged when sourceHash changed; NOT flagged when symbol untouched; NOT flagged when finding is genuinely new (no prior on that symbol); defense-in-depth for multiple priors.

### Piece 13 — skill + UI surfacing

- [x] 13.1 `src/app/api/command/[[...args]]/route.ts`: separate `regressions` array in response (findings with `isRegression=true`).
- [x] 13.2 `.claude/skills/dragnet/SKILL.md`: document `regressions`; render as `⚠ Regressions (introduced by prior fix):` section, distinct from new/open findings.
- [x] 13.3 UI banner: regression chip in PR view, distinct color.
- [x] 13.4 Ship: lint clean, vitest green, commit on `main` as `8d9e8be`.

## PR5 — Stability / convergence score (DONE in 57e1e61 — Issue #18)

### Piece 14 — compute + expose

- [x] 14.1 New `src/lib/stabilityScore.ts` (~80 lines): pure function `computeStability(ratingTrend, newFindingsByRun, opts): { consecutiveCleanRounds, readyToMerge, lastUnstableRunId? }`. Walk ratingTrend latest-first, count runs where `rating >= threshold && newFindingsCount === 0`, stop at first failure.
- [x] 14.2 `src/lib/reviewFreshness.ts:getRecentRuns`: extend return shape to include `newFindingsCount` per run (count `ReviewFinding` where `firstSeenRunId === run.id`).
- [x] 14.3 `src/app/api/command/[[...args]]/route.ts`: add `stability` field to `prcheckstatus` response. Hardcoded `STABILITY_RATING_THRESHOLD = 8`, `STABILITY_MIN_ROUNDS = 3`. Env-overridable.
- [x] 14.4 Tests `tests/stabilityScore.test.ts`: clean 3 rounds passes; 2 clean + 1 dirty fails; single-scan PR returns `readyToMerge=false`; new findings in a round fails even at rating 9.

### Piece 15 — skill + UI

- [x] 15.1 `.claude/skills/dragnet/SKILL.md`: document `stability`; render `✓ Stable — N consecutive clean rounds (ready to merge)` or `◐ Unstable — rating or findings still fluctuating`.
- [x] 15.2 UI banner in PR view: stability chip next to rating.
- [x] 15.3 Ship: lint clean, vitest green, commit on `main` as `57e1e61`.

## PR6 — Rating calibration by model tier (DONE in c76dd02 — Issue #20)

### Piece 16 — trust weights

- [x] 16.1 New `src/lib/modelTrustWeights.ts` (~60 lines): hardcoded `MODEL_TRUST_WEIGHTS: Record<string, number>` (Claude Opus 4.7: 1.0, Sonnet 4.6: 0.9, Haiku 4.5: 0.7, GPT-4o: 0.9, GPT-4o-mini: 0.5, Minimax: 0.7, GLM-4.6: 0.8, GLM-4.5-flash: 0.5, Ollama locals: 0.4, unknown: 0.5). Prefix-match like `llmPricing`. Env override `DRAGNET_MODEL_TRUST_<UPPER>=N`.
- [x] 16.2 Tests `tests/modelTrustWeights.test.ts`: known model returns weight; prefix match works; unknown returns 0.5; env override works.

### Piece 17 — weighted stability

- [x] 17.1 In `src/lib/stabilityScore.ts`: add `computeWeightedStability(ratingTrend, trustWeights): number`. Update `readyToMerge` to use `weightedStability >= STABILITY_WEIGHT_THRESHOLD` (default 2.5, env-overridable).
- [x] 17.2 `prcheckstatus` response includes both raw `consecutiveCleanRounds` and `weightedStability`. UI shows weighted.
- [x] 17.3 v2 (deferred until spec 1100 ships): use `ReviewRun.tokensUsed.providers` for multi-provider runs. For v1, single `ReviewRun.model` per run is enough.
- [x] 17.4 Ship: lint clean, vitest green, commit on `main` as `c76dd02`.

## Tracked as GitHub issue

- [x] Created as [issue #42](https://github.com/darrenedwardhouseofjones/Dragnet/issues/42) with `ready-for-agent` label.

## New blockers / open questions (added 2026-07-01)

- **PR4 false-positive risk:** if a fix intentionally restructures a symbol (rename, refactor), `sourceHash` changes even without introducing a bug. New finding on that symbol would false-flag as regression. Mitigation: only flag if the new finding's category matches the prior resolved finding's category — "the same bug came back" not "any new bug in this area." Refine during impl.
- **PR5 threshold tuning:** `MIN_ROUNDS=3` and `RATING_THRESHOLD=8` are starting guesses. Need real-world data to calibrate. Add a `--strict` flag later for teams that want stricter convergence.
- **PR6 trust weight drift:** models improve over time. Add `// LAST VERIFIED: 2026-07-01` and a quarterly review reminder.
- **Cross-spec dependency:** PR6 v2 (multi-provider weighting) needs spec `2026-07-01-1100-cost-telemetry-failure-classifier` shipped. Track in roadmap.
- **PR4 + PR5 ship together?** They naturally pair in the UX (regression count + stability score both feed the "ready to merge" verdict). Consider bundling into one commit if the diff stays under 500 lines.
