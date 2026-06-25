# Tasks — Scan Quality + History Redesign

## Phase 1 — Filename Attribution Fix (P0)

- [x] 1.1 Partition diff payload into code files + CONTEXT FILES section (`reviewService.ts:363-394`)
- [x] 1.2 Strengthen SYSTEM_INSTRUCTION with explicit filename rule (`reviewService.ts:267-280`)
- [x] 1.3 Strengthen JSON finalizer prompt with filename requirements (`reviewService.ts:609-613`)
- [x] 1.4 Replace silent `files[0].filename` fallback with `<unattributed>` sentinel; verifier rejects with clear note (`reviewService.ts:680,701`, `findingVerifier.ts:174-179`)
- [x] 1.5 End-to-end verification — scan on `feature-agent-blog-api` produced 15 findings, ZERO citing `.md` / `.agent-os/` / docs. All citations point to actual `.ts` / `.tsx` / `package.json` source files. Runtime log confirmed `partitioned 153 file(s) → 109 code, 44 context`.

## Phase 2 — Rating/Findings Honesty (P1)

- [x] 2.1 Null rating on ReviewRun when verifier rejects 100% of findings
- [x] 2.2 Return full `rejectedFindings` list from `/api/prs/[prId]/findings` (not just count)
- [x] 2.3 Render rejected findings inline in ReviewCard with amber chip + verifier note
- [x] 2.4 Distinct empty-state copy for `rating=null && reviewRun` (don't say "no findings")
- [~] 2.5 Verification — **partial path verified** (14 verified / 1 rejected → rating correctly stays non-null, `rejectedFindings` populated, confirmed on `run-2b4a1f53-ce1b-4602-a82a-1dc888b287a8`). **100%-rejected path is code-inspection only** — no natural test case in historical data, and M3 won't reliably produce one. Branch lives at `reviewService.ts:684-690`.

## Phase 3 — Per-Scan Log Isolation + History UI (P2)

- [x] 3.1 Add nullable `reviewRunId` to ReviewLog + index; migration SQL
- [x] 3.2 Update `logReviewEvent` to accept + persist `reviewRunId`
- [x] 3.3 Drop obsolete `deleteMany({ where: { prId } })` from scan route
- [x] 3.4 `/api/reviews/log?reviewRunId=X` filter (prId fallback for legacy)
- [x] 3.5 New endpoint: `GET /api/prs/[prId]/runs`
- [x] 3.6 Refactor ReviewProgress to poll by `reviewRunId`
- [x] 3.7 New `ScanHistory` component
- [x] 3.8 Refactor PrsView layout into 4 sections
- [ ] 3.9 Verification — runtime data confirmed via DB probes (logs from fresh scan `run-87cb6ee2` show `reviewRunId` populated on every row; `/runs` endpoint returns proper shape). **UI rendering (expandable rows, "current" chip, inline log viewer) needs a browser smoke test** — can't be curl-verified.

## Phase 4 — Concurrency Guard + UI Status Sync (P3)

- [x] 4.1 `assertNoActiveScan(prId, force)` helper; wired into all 4 scan trigger paths
- [x] 4.2 Sync `isScanning` with `activePR.status === "In Progress"`
- [x] 4.3 No sidebar regression — background poller still uses refs (`repoIdRef`, `prIdRef`); new `isScanning` sync uses state-derived `prs.find()`, not closure capture
- [ ] 4.4 Verification — **concurrency guard verified via probe**: synthetic `in_progress` row → `GET /api/prcheck/X` returned `409 SCAN_IN_PROGRESS` with correct `runId` + `startedAt` + override hint. **UI `isScanning` sync (Phase 4.2) needs a browser smoke test** to confirm the visual state actually flips when a curl-triggered scan starts.

## Phase 5 — GitHub-style Scan History Expansion (P2)

User feedback (2026-06-25): "when a new scan is initiated the old scan data should be push to history and the history at the bottom of the content should show the history if the user wants to view it, kind of like what happens on github where you can see pr comment history."

The Phase 3 ScanHistory only showed log lines when expanding a historical run. GitHub PR comment history shows the actual review content. Phase 5 closes that gap — each historical run expands to its full findings list.

- [x] 5.1 New endpoint: `GET /api/reviews/run?reviewRunId=X` — returns reviewRun metadata + findings + rejectedFindings + rejectedCount for any run (mirrors `/api/prs/[prId]/findings` shape but parameterized by runId, not "latest"). Validated against real run `run-76c68021` → 8 visible + 1 rejected finding returned with full field set (filename, line, severity, category, source, confidence, verificationStatus). (`src/app/api/reviews/run/route.ts`)
- [x] 5.2 New component `HistoryFindingRow` — compact read-only rendering of a single finding (severity badge, source chip when not LLM, category, filename:line, explanation). Shared between visible + rejected lists; rejected rows get amber tint + verifier note. (`src/components/views/prs/HistoryFindingRow.tsx`)
- [x] 5.3 ScanHistory refactor — hide `in_progress` runs from the list (they're already live in ReviewProgress above), lazy-fetch BOTH logs AND findings on first expand, render findings section + collapsible "Verifier rejected: N" section + logs section. Finding count chip appears in the row once loaded. (`src/components/views/prs/ScanHistory.tsx`)
- [x] 5.4 Typecheck passes clean (`npx tsc --noEmit`).
- [ ] 5.5 Browser smoke test — expand a historical run, confirm findings list renders with severity colors + source chips + filename:line, then expand "Verifier rejected" section and confirm rejected rows show amber tint + verification note.

## Phase 6 — Move Old Findings to History on Scan Start (P1)

User feedback (2026-06-25, screenshot + correction): "when a user lcick pr review button and initiates a scan, the previous/old results should go into the hisstory". Previously ReviewCard kept showing the previous completed run's findings during a new scan (because `getLatestCompletedReview` filters to `status: "completed"`, and the in-progress run is excluded). User expectation: the moment a scan kicks off, ReviewCard should clear and the previous run becomes the top entry in Scan History (where its findings are already accessible via the expand arrow).

- [x] 6.1 Pass `isScanning` prop from `PrsView` → `ReviewCard`. Already threaded through `useDashboardData` → `App` → `PrsView`; only the last hop into `ReviewCard` was missing. (`src/components/views/PrsView.tsx`)
- [x] 6.2 Add scanning-state branch in `ReviewCard` body — when `isScanning === true`, render a "AI review pipeline running" placeholder with spinner + a one-line hint pointing at Review Progress + Scan History, instead of the old findings list. Suppress the "Verifier rejected" footer and the "Copy All" / rating chips in the header while scanning. Header title swaps to "AI Review In Progress" with a spinner icon. (`src/components/views/prs/ReviewCard.tsx`)
- [x] 6.3 Typecheck clean (`npx tsc --noEmit`).
- [ ] 6.4 Browser smoke test — with a completed scan's findings visible, click "Trigger AI Review Scan" and confirm: (a) ReviewCard body flips to the scanning placeholder, (b) header loses the rating chip + Copy All, (c) the previous run remains the top row of Scan History with its findings still expandable, (d) on completion ReviewCard refreshes with the new run's findings.

## Outstanding — user-driven UI smoke test

One browser pass to close out Phases 3.9, 4.4, 5.5, and 6.4 (rendering only — underlying API endpoints already verified):

1. Click "Trigger AI Review Scan" → watch ReviewProgress stream iteration logs
2. After completion → expand a ScanHistory row, confirm findings list renders (not just logs) with severity badges + source chips + filename:line
3. Expand the "Verifier rejected: N" sub-section — confirm rejected rows show amber tint + verifier note
4. Trigger a second scan → confirm old run moves to history with its findings still viewable, new run is highlighted
5. Trigger a scan via `curl /api/prcheck/X?force=true` from terminal → confirm sidebar shows "In Progress" without clicking the UI button (verifies Phase 4.2 visual sync)
