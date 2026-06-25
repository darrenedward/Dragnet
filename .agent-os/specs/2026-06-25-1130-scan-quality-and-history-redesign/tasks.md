# Tasks — Scan Quality + History Redesign

## Phase 1 — Filename Attribution Fix (P0)

- [x] 1.1 Partition diff payload into code files + CONTEXT FILES section (`reviewService.ts:363-394`)
- [x] 1.2 Strengthen SYSTEM_INSTRUCTION with explicit filename rule (`reviewService.ts:267-280`)
- [x] 1.3 Strengthen JSON finalizer prompt with filename requirements (`reviewService.ts:609-613`)
- [x] 1.4 Replace silent `files[0].filename` fallback with `<unattributed>` sentinel; verifier rejects with clear note (`reviewService.ts:680,701`, `findingVerifier.ts:174-179`)
- [ ] 1.5 End-to-end verification: re-scan `feature/bug-demo`, confirm zero `.md` citations (blocked by M3 flakiness — structural verification confirmed via log partition)

## Phase 2 — Rating/Findings Honesty (P1)

- [x] 2.1 Null rating on ReviewRun when verifier rejects 100% of findings
- [x] 2.2 Return full `rejectedFindings` list from `/api/prs/[prId]/findings` (not just count)
- [x] 2.3 Render rejected findings inline in ReviewCard with amber chip + verifier note
- [x] 2.4 Distinct empty-state copy for `rating=null && reviewRun` (don't say "no findings")
- [ ] 2.5 Verification: rejected findings visible, no misleading X/10 with zero findings

## Phase 3 — Per-Scan Log Isolation + History UI (P2)

- [x] 3.1 Add nullable `reviewRunId` to ReviewLog + index; migration SQL
- [x] 3.2 Update `logReviewEvent` to accept + persist `reviewRunId`
- [x] 3.3 Drop obsolete `deleteMany({ where: { prId } })` from scan route — per-run isolation via reviewRunId supersedes it; old scans become history instead of being destroyed
- [x] 3.4 `/api/reviews/log?reviewRunId=X` filter (prId fallback for legacy)
- [x] 3.5 New endpoint: `GET /api/prs/[prId]/runs` — list all runs
- [x] 3.6 Refactor ReviewProgress to poll by `reviewRunId`; renders even after scan completes (shows last run's log)
- [x] 3.7 New `ScanHistory` component — fetches `/runs`, each row expandable to show that run's logs
- [x] 3.8 Refactor PrsView layout into 4 sections: status / logs / results / history
- [ ] 3.9 Verification: per-scan log isolation, history expands correctly

## Phase 4 — Concurrency Guard + UI Status Sync (P3)

- [x] 4.1 `assertNoActiveScan(prId, force)` in reviewFreshness.ts; wired into all 4 scan trigger paths (`/api/prs/[prId]/scan`, `/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command/[[...args]]`); returns 409 with runId + startedAt
- [x] 4.2 Sync `isScanning` with `activePR.status === "In Progress"` so API/skill/hook-triggered scans show UI state
- [ ] 4.3 Verify no regression on the sidebar fix (use refs, not closure state)
- [ ] 4.4 Verification: UI button + curl + `/gloop` skill can no longer race on same PR
