# Tasks — Index Freshness Gates + UI Hardening

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — indexedAt gate on bypassing scan paths

- [x] Add `indexedAt` check to `src/app/api/hooks/prepush/route.ts` (return `{passed:false, error:"INDEX_REQUIRED"}` with 409).
- [x] Add `indexedAt` check to `src/app/api/mcp/prcheck/[prIdOrNumber]/route.ts` (return `{status:"Error", message:"..."}` with 409).
- [x] Add `indexedAt` check to `handlePrCheck` in `src/app/api/mcp/command/[[...args]]/route.ts` (return markdown hint string).
- [x] Add `indexedAt` check to legacy `prcheck` branch in same file (return markdown hint JSON).
- [x] `npm run lint` clean.
- [ ] Manual: prepush on un-indexed repo returns 409, MCP prcheck returns Error.

## Phase 2 — Staleness check (HEAD vs indexed-at HEAD)

- [x] Create `src/lib/indexFreshness.ts` exporting `assertIndexFresh(repo)` discriminated union. Uses `execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'])` — never shell.
- [x] Populate `lastCommitHash` in `indexingService.ts` after both success sites (short-circuit ~417 + full success ~550).
- [x] Replace Phase 1 inline checks at all 4 scan entry points with `assertIndexFresh` calls. Each surface maps `kind:"STALE_INDEX"` to its own response envelope.
- [x] `npm run lint` clean.
- [ ] Manual: change a file, commit, scan returns 409 STALE_INDEX. After reindex, scan returns 200.

## Phase 3 — BigInt serialization fix

- [x] Map `summaryAt` BigInt → string in `/api/repos/[id]/symbols/route.ts`.
- [x] Check `/api/repos/[id]/files` route for same issue; fix if affected. (Audited — `/callgraph` already maps to safe shape, `/edges` has no BigInt column, no `/files` route exists.)
- [x] `npm run lint` clean.
- [ ] Manual: `curl localhost:3300/api/repos/{id}/symbols` returns 200 array, no BigInt error.

## Phase 4 — UI in-flight guard

- [x] Add derived `busy = isReindexing || isScanning` flag in `PrsView.tsx` ScanToolbar.
- [x] Scan button `disabled={busy || !repoIndexedAt}`.
- [x] Reindex button `disabled={busy}`.
- [x] Verify `onIndexComplete` callback refreshes `lastCommitHash` via the repos GET. (Chain is unchanged — `onIndexComplete` triggers `fetchRepos` in the parent which re-reads the repo row including lastCommitHash.)
- [x] `npm run lint` clean.
- [ ] Manual: click Reindex → Scan button disabled until Reindex lands.

## Phase 5 — Presets .bak spam

- [ ] Add module-level `warnedAboutBakFallback` boolean in `src/lib/llmPresets.ts`.
- [ ] Wrap the existing `.bak fallback` warn so it fires once per process.
- [ ] `npm run lint` clean.

## Final verification

- [ ] `npm run lint` clean.
- [ ] `npm test` — 33 tests still pass.
- [ ] Commit each phase individually per the user's `git add .` convention.
