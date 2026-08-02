# Golden / manual confidence checklist (#146 / #151)

Use after implementing large-PR chunk quality + Review Limits SSOT + queue policy.

## Automated (vitest)

- [x] Multi-chunk duplicate fingerprints → one published survivor  
  `tests/largePrMode/publishFindings.test.ts`, `dedupFindingsWithinRun.test.ts`
- [x] Raising normal max lines → fewer chunks for synthetic manifest  
  `tests/largePrMode/reviewLimitsSsot.test.ts`
- [x] Cluster merge + no-merge (unrelated / low-confidence)  
  `tests/largePrMode/cluster.test.ts`
- [x] Queue wake-on-admit + auto-rescan default off  
  `tests/scanQueue.test.ts`, `tests/autoRescanPolicy.test.ts`, `tests/scanAdmission.test.ts`

```bash
npx vitest run tests/largePrMode tests/scanQueue.test.ts tests/scanAdmission.test.ts tests/autoRescanPolicy.test.ts tests/prSizeConfig.test.ts tests/reviewLimitsRoute.test.ts
npm run lint
```

## Manual

### Findings quality

1. **Known-bug PR** — open a PR with a deliberate bug; run explicit review (UI Run or `prcheck`). Expect the bug once after multi-chunk (no systematic double-report).
2. **Clean PR** — small green PR; expect high rating / few or no findings; merge gate still independent of “scan finished”.
3. **Grouped / large PR** — PR above normal max lines/files; header shows chunk progress; published findings fingerprint-clean; high-confidence cross-chunk root causes may appear as one multi-location finding.

### Review Limits

4. Settings → Review Limits: note shipped defaults (800/40 normal, 3000/100 oversized, chunk 600). Raise **Normal — max lines**, Save, re-scan a mid-size PR → fewer chunks on next scan (no process restart).
5. Confirm help text: limits are **diff lines + code files**, not 500 LOC authoring. Effective chunk cap visible under Chunking.

### Queue drain (auto-rescan off)

6. Leave Automatic rescans **off** (product default).
7. Admit review on PR A (explicit). While A is running (or fill global concurrency), admit PR B → B shows queued.
8. When A completes, B **auto-starts** without operator action (slot auto-start). Wake-on-admit should not wait solely on the poll interval.
9. Push a new tip with auto-rescan off → AFK path must **not** enqueue; explicit Run still works.
