# Golden / manual confidence checklist (#151)

Operators and agents: use after large-PR chunk quality + Review Limits SSOT +
queue policy + post-aggregate publish (+ cluster when shipped).

Vocabulary: **scan finished** ≠ **merge ready**. Explicit admit (UI Run /
`prcheck`) always enqueues; AFK auto-rescan is separate and defaults **off**.

## Automated (vitest)

- [x] Multi-chunk duplicate fingerprints → one published survivor  
  `tests/largePrMode/goldenConfidence.test.ts`,  
  `tests/largePrMode/publishFindings.test.ts`,  
  `tests/largePrMode/dedupFindingsWithinRun.test.ts`
- [x] Raising normal max lines (Settings / `saveLimits`) → fewer chunks  
  `tests/largePrMode/goldenConfidence.test.ts`,  
  `tests/reviewLimitsSsot.test.ts`
- [x] Cluster merge + no-merge (unrelated / low-confidence)  
  `tests/largePrMode/goldenConfidence.test.ts`,  
  `tests/largePrMode/cluster.test.ts`
- [x] Queue wake-on-admit + second job auto-starts when slot frees;  
  auto-rescan default off  
  `tests/scanQueue.test.ts`,  
  `tests/autoRescanPolicy.test.ts`

```bash
npx vitest run \
  tests/largePrMode/goldenConfidence.test.ts \
  tests/largePrMode/publishFindings.test.ts \
  tests/largePrMode/cluster.test.ts \
  tests/largePrMode/dedupFindingsWithinRun.test.ts \
  tests/reviewLimitsSsot.test.ts \
  tests/scanQueue.test.ts \
  tests/autoRescanPolicy.test.ts
npm run lint
```

## Manual

### Findings quality

1. **Known-bug PR** — open a PR with a deliberate bug; run explicit review
   (UI Run or `prcheck`). Expect the bug **once** after multi-chunk (no
   systematic double-report of the same fingerprint).
2. **Clean PR** — small green PR; expect high rating / few or no findings.
   Merge gate remains independent of “scan finished”.
3. **Grouped / large PR** — PR above normal max lines/files; header shows
   chunk progress; published findings are fingerprint-clean. High-confidence
   cross-chunk root causes may appear as one multi-location finding (cluster).

### Review Limits

4. Settings → Review Limits: note shipped defaults (800/40 normal, 3000/100
   oversized, chunk floor 600). Raise **Normal — max lines**, Save, re-scan a
   mid-size PR → **fewer chunks on the next scan** (no process restart).
5. Confirm help text: limits are **diff lines + code files**, not 500 LOC
   authoring. Effective chunk cap is max(chunkLineCap, normalMaxLines).

### Queue drain (auto-rescan off)

6. Leave Automatic rescans **off** (product default).
7. Admit review on PR A (explicit). While A is running (or fill global
   concurrency), admit PR B → B shows **queued**.
8. When A completes, B **auto-starts** without operator action (slot
   auto-start). Wake-on-admit should not wait solely on the poll interval.
9. Push a new tip with auto-rescan off → AFK path must **not** enqueue;
   explicit Run still works.

### Cluster (when shipped)

10. Large PR where the same root cause is reported at two locations with high
    confidence → one published multi-location finding (merge case).
11. Unrelated findings or low-confidence pairs → remain separate (no-merge).
