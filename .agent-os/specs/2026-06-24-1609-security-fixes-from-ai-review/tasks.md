# Tasks — Security fixes from AI code review

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Findings from AI review (8 total)

- 6 verified real, 2 verified false positives.

### Verified real (fixed)

- [x] **#1 Host-header auth bypass** — `authenticateIfExternal` trusted attacker-controllable HTTP/1.1 `Host` header. Any TCP client sending `Host: localhost:3300` bypassed auth on `/api/repos/[id]/stats`, `/reindex`, and `/webhook` (3 verbs). Replaced with `authenticateSessionOrKey` which validates either a Bearer API key (DB lookup) or a Better Auth session cookie via `requireSession`. Updated `src/lib/apiAuth.ts` + 5 call sites (`stats`, `reindex`, `webhook` × 3 verbs).
- [x] **#4 Cross-repo PR leak** — `findPrByIdOrNumber` did fuzzy/ordinal/contains matching with no `repoId` scope. An API key valid for repo A could resolve PRs in repo B by guessing ordinals. Now requires `repoId` for any non-exact-ID matching. Command route passes `args.repoId`/`body.repoId`; path routes accept `?repoId=` query param. `src/lib/findPr.ts` + 4 callers.
- [x] **#6 Misleading reindex response** — fire-and-forget indexing returned `{success: true}` immediately, lying about work not yet done. Now returns `202 Accepted` with `status:"stabilizing"` and points caller at the stats endpoint for polling. `src/app/api/repos/[id]/reindex/route.ts`.
- [x] **#3 Predictable SSH key path** — `buildSshEnv` wrote the deploy key to `/tmp/greploop-deploykey-<keyId>`, a path attackers could pre-create or race. Switched to `mkdtempSync` with a `0o700` private directory and `unlink + rmdir` cleanup. `src/lib/gitRemote.ts`.

### Verified false positives (skipped)

- **#5 proxy blocks UI fetches** — false positive. `proxy.ts` uses Better Auth's `getSessionCookie` for cookie-presence check, which detects auth cookies before signature validation. Authenticated browser requests pass through.
- **#8 webhook URL injection** — false positive. `getProviderFromUrl` only returns `"github"` or `"gitlab"` and defaults to `"github"`; no arbitrary-provider routing.

### Acknowledged tradeoffs (not fixed)

- **#7 delete+create race** in `getRealLocalPrs.ts:163` — concurrent pushes could collide. Not fixed; flagged as separate work.

## Verification

- [x] `npm run lint` clean (`tsc --noEmit` passes).
- [x] `grep -rn "authenticateIfExternal" src/` — only the doc comment in `apiAuth.ts:51` remains.
- [x] All 4 fixes committed in `2e4113e` on `feature/bug-demo`.

## Manual smoke tests (not yet run)

- [ ] Without API key or session cookie, `GET /api/repos/[id]/stats` returns 401 from any Host header value.
- [ ] With API key for repo A, `GET /api/prcheck/1` (no repoId) returns null/404 (no fuzzy match).
- [ ] With API key for repo A, `POST /api/repos/[B]/reindex` returns 401 (key not valid for repo B).
- [ ] `mkdtempSync` path is created with 0700 mode; verify with `stat` after a reindex of a deploy-key repo.
