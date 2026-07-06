# Tasks — Scan reports to `.dragnet/reports/` + `/dragnet report`

Update status as work progresses. Mark each `[x]` only when the work is actually done.

## Piece 0 — Bug fix (DONE in 8417e12)

- [x] 0.1 Step 6's `export-markdown/route.ts:128` was writing to `process.cwd()/.dragnet/reviews/` (= Dragnet install dir) instead of `repo.path/.dragnet/reviews/` (= scanned repo). Fixed in commit `8417e12`. Same invariant applies to Piece 1.

## Piece 1 — Disk mirror in `logRun()`

- [x] 1.1 Extend `logRun()` in `src/services/largePrReview/orchestrator.ts` to accept `repoPath: string` (passed through from `runLargePrReview` callers — they already have it). Inside, after the DB write, append a single line to `<repoPath>/.dragnet/reports/<runId>.log`. Format: `<ISO> [<level>] [<chunkId?>] <message>`. Best-effort: catch append errors and log a warning, don't propagate. Disk-write logic extracted to `src/services/largePrReview/reportLogger.ts` (`formatReportLine` + `appendReport`) so it's testable without prisma mocks and orchestrator.ts stays under 500 lines. Commit `aaf8c35`.
- [x] 1.2 Update all existing `logRun()` call sites in `orchestrator.ts` (7 in `runLargePrReview` + `runChunkWithRetry` + retryFailedChunk's call into `runChunkWithRetry`) to pass `repoPath`. The function signature change forces this — TypeScript verified via lint.
- [x] 1.3 Skip the disk write when `repoPath` is empty/undefined (legacy callers, tests) — DB write still happens. `appendReport` returns early.
- [x] 1.4 `tests/reportLogger.test.ts` (13 tests) — covers: formatReportLine permutations (timestamp/level/chunkId/missing-chunkId), mkdir -p, multi-line append preserves order, run isolation, repoPath-not-process.cwd() invariant, empty-arg no-ops, fs-error swallowing.
- [x] 1.5 `npm run lint` + `npx vitest run` clean (185/185).

## Piece 2 — Remove App.tsx stub

- [x] 2.1 Deleted the "Sync local report folder" button at `src/App.tsx:334-341`. Commit `4f3b5e0`.
- [x] 2.2 Verified no other references to the removed button (grep `Sync local report`, `local report folder` → only hits are Piece 1's new code).
- [x] 2.3 `npm run build` clean.

## Piece 3 — `/dragnet report` skill subcommand

- [x] 3.1 Added `/dragnet report` to the command table in `.claude/skills/dragnet/SKILL.md`. Commit `27cfa51`.
- [x] 3.2 Added the full Subcommand protocol section (8 steps): resolve repo root, glob newest `.dragnet/reports/*.log` by mtime, read, extract error lines, triage into 4 categories, render table, fix code-fixable only with user confirmation, re-test via `prcheck`, render before/after.
- [x] 3.3 Documented the don't-code-fix-config/env-errors rule with 4 explicit categories + examples (Ollama binary missing → env, no chat API key → config, "no grammar yet" → expected, TypeError in src/foo.ts → code-fixable).
- [x] 3.4 Synced to `~/.claude/skills/dragnet/SKILL.md` (336 lines).

## Piece 4 — Ship

- [x] 4.1 `npm run lint` (tsc --noEmit) passes.
- [x] 4.2 `npm run build` passes.
- [x] 4.3 `npx vitest run` — full suite green (185/185, +13 from baseline 172).
- [ ] 4.4 Manual: run a scan from the website on a real PR; verify `.dragnet/reports/<runId>.log` appears in the SCANNED repo (not the Dragnet install); contents include chunk-level events. *(Manual — run at next scan session)*
- [ ] 4.5 Manual: trigger a scan failure (e.g. revoke API key temporarily); verify the report file captures the failure with `[error]` level. *(Manual — run at next scan session)*
- [ ] 4.6 Manual: invoke `/dragnet report` from inside the scanned repo; verify it reads the newest report, renders triage table, proposes reasonable fixes. *(Manual — run at next scan session)*
- [x] 4.7 Committed directly to `main` (no separate branch — small diff, internal tool). 4 commits total: `8417e12` (bug fix), `aaf8c35` (Piece 1), `4f3b5e0` (Piece 2), `27cfa51` (Piece 3). Total diff ~290 lines, well under 500-line budget.

## Piece 5 — Tracked as GitHub issue

- [x] 5.1 Created as [issue #41](https://github.com/darrenedwardhouseofjones/Dragnet/issues/41) with `ready-for-agent` label.

## Blockers / open questions

- Phase 2: extend coverage to normal-PR scans (`runPrScan`). Currently they don't call `logRun()` at all, so they'd produce empty report files. Either add `logRun()` calls to the normal path, or write the report file directly from a different hook. Defer until v1 lands and user validates the large-PR flow.
- Phase 2: cleanup policy for old report files. Not blocking v1 — manual cleanup acceptable while volume is low.
