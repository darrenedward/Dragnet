# Tasks — Deploy-Key Remote Repos

Mark each task `- [x]` when complete. Add follow-up tasks under "Discovered during work" as the implementation surfaces them.

## Pre-flight

- [x] **Revoke leaked MCP API key** in `opencode.json` (commit `4fc0596`). Key: `<KEY_REVOKED>`. Revoked via API deletion. Generated new key `gl_mcp_4d747...`. Added `opencode.json` to `.gitignore`.
- [x] **Clean up commit `4fc0596`** — added `opencode.json` to `.gitignore`. Local-only branch, no push.

## Phase 0 — Crypto + startup hardening (no DB changes)

- [x] **0.1** `src/lib/crypto.ts` — AES-256-GCM wrapper. Exports `encryptSecret`, `decryptSecret`, `hasMasterKey`. Master key from `GREPLOOP_MASTER_KEY` (base64, 32 bytes), cached in `globalThis`. Fail loud if missing/malformed.
- [x] **0.2** `src/lib/startupAudit.ts` — chmod 0600 enforcement on `.env*` and `.greploop/*`. Fixes mode + logs warning; never throws.
- [x] **0.3** `src/instrumentation.ts` — Next.js startup hook. Calls `startupAudit()` once per boot via `globalThis.__greploopAuditDone` guard.
- [x] **Verify:** Crypto round-trip test (4 tests pass). Startup audit logged `fixed mode to 0600: .env.local, .greploop/mcp.sh` on server boot.

## Phase 1 — Schema migration

- [x] **1.1** Edit `prisma/schema.prisma` Repository model: `path String? @unique`, add `provider`, `cloneUrl`, `deployKeyCipher/Iv/Tag`, `patCipher/Iv/Tag`, `webhookSecret`, `webhookId`, `lastFetchAt`, `localPath`.
- [x] **1.2** `npx prisma db push` via direct Supabase connection (port 5432, not pgbouncer). Prepared-statement errors when using pgbouncer — use direct connection for schema changes.
- [x] **Verify:** Existing local-repo registration still works (3 repos, PR listing). No type errors (tsc clean). All 33 tests pass.

## Phase 2 — Remote git access

- [x] **2.1** `src/lib/gitRemote.ts` — `cloneRepo`, `fetchRepo`, `buildSshEnv`. All shell calls via `execFileSync("git", args, { cwd, env })`. SSH deploy key written to mode-0600 tmp file, cleaned up in `finally` block. PAT injected as `x-access-token:<pat>@host` in clone URL. Clone dir `${REPOS_DIR||cwd/.repos}/<repoId>/`.
- [x] **2.2** `src/services/remoteFetchWorker.ts` — `enqueue(repoId)` with Set-based dedup lock. Reads repo from DB, decrypts deployKey/PAT via `crypto.ts`, calls `cloneRepo` if no localPath else `fetchRepo`, then `indexingService.indexFolder()`. Persists `localPath` and `lastFetchAt`.
- [x] **Verify:** `npm run lint` (tsc) passes. All 33 tests pass. Dev server starts, existing local repos still work (3 repos listed). New fields `provider`, `localPath` show as null in existing records.

## Phase 3+4 — Registration API + webhook setup

- [x] **3.1** Modified `POST /api/repos` registration handler: accepts `{ mode: "local"|"ssh"|"pat", path?, cloneUrl?, cloneUrlHttps?, deployKey?, pat? }`. Encrypts secrets via `crypto.ts`, stores cipher/iv/tag, sets provider from URL. Kicks off `remoteFetchWorker.enqueue()` for remote repos, returns auto-generated `webhookSecret`.
- [x] **3.2** Added `cloneUrlHttps` column to schema for HTTPS variant (API calls when primary URL is SSH).
- [x] **4.1** `src/lib/webhookSetup.ts` — `setupWebhookWithPat()` (GitHub + GitLab auto-create via API), `deleteWebhook()`, `getManualWebhookInstructions()` (fallback markdown), `getProviderFromUrl()` ("github"|"gitlab" extraction from URL). Reads `GREPLOOP_PUBLIC_URL` env.
- [x] **4.2** `src/app/api/repos/[id]/webhook/route.ts` — POST to create (auto via PAT or manual via `{webhookId}` body), DELETE to tear down via API.
- [x] **Verify:** Typecheck clean (tsc). All 33 tests pass. Dev server starts, repos list still works (3 local repos).

## Phase 5+6 — Webhook hardening + UI

- [x] **5.1** Wired `verifyGithubSignature()` into GitHub webhook handler. Created `verifyGitlabToken()` (timing-safe comparison). Both return 401 on mismatch. Existing local repos with no webhookSecret skip verification gracefully.
- [x] **5.2** `findRepoByCloneUrl()` updated: matches remote repos by `cloneUrl` field directly (no `execSync` needed). Returns `{ id, localPath, webhookSecret }`. Local repos still resolved via `git remote get-url origin`.
- [x] **5.3** Both webhook handlers (GitHub + GitLab) use `gitFetch` + `scanRepoPrs` for local repos, `enqueue(remoteFetchWorker)` for remote repos.
- [x] **6.1** Split AddRepoModal into `src/components/modals/addRepo/` directory: `index.tsx` (tabbed parent), `LocalTab.tsx` (existing path form), `RemoteTab.tsx` (new remote form), `shared.tsx` (Field + inputClass), `WebhookPrompt.tsx` (post-success setup prompt).
- [x] **6.2** Remote tab fields: Clone URL, optional HTTPS URL for API calls, mode toggle (SSH deploy key / PAT), secret textarea/input. `WebhookPrompt` on success with auto-setup (PAT) or manual instructions.
- [x] **6.3** Added `newRepoMode`, `newCloneUrl`, `newDeployKey`, `newPat`, `newCloneUrlHttps` state to `useDashboardData`. `handleAddRepo` sends `mode` field to API and shows WebhookPrompt for remote repos.
- [x] **Verify:** Typecheck clean. All 33 tests pass. Dev server starts. Old AddRepoModal.tsx removed.

## Phase 7 — Edit Repo (post-registration edit)

- [x] **7.1** Extend `PUT /api/repos/[id]` to accept `{ mode, cloneUrl, cloneUrlHttps, deployKey, pat, path }` alongside the existing operational fields. Secrets (`deployKey`, `pat`) encrypted via `crypto.ts`; empty/missing secrets preserve existing ciphertext ("leave blank to keep current"). For `path` edits, persist the new local path. For remote-mode edits, re-enqueue `remoteFetchWorker` if clone URL or secrets changed.
- [x] **7.2** Create `src/components/modals/editRepo/` directory mirroring `addRepo/`: `index.tsx` (tabbed parent, prefilled from current repo), `LocalTab.tsx`, `RemoteTab.tsx`, `shared.tsx` (re-export from `addRepo/shared`), `WebhookPrompt.tsx` (reuse `addRepo/WebhookPrompt` directly). Secret fields render empty with "leave blank to keep current" hint.
- [x] **7.3** Add cog-icon edit button per repo row in `src/components/DashboardSidebar.tsx`. Opens EditRepoModal for that repo.
- [x] **7.4** Wire `handleEditRepo(repo)` into new `src/hooks/useEditRepo.ts` (extracted to keep `useDashboardData.ts` under 500 lines). PUTs to `/api/repos/[id]`, then refreshes repo list. Shows WebhookPrompt only if cloneUrl/mode changed.
- [x] **Verify:** Typecheck clean. All 33 tests pass. EditRepoModal renders with prefilled values; secret fields show "leave blank to keep current" hint. WebhookPrompt only fires on mode/URL change, not secret rotation.

## Phase 8 — Deployment topology detection (localhost vs public URL)

- [x] **8.1** New `src/lib/publicUrl.ts` — `getPublicUrl(): { url: string; isLocal: boolean }`. Reads `GREPLOOP_PUBLIC_URL` (default `http://localhost:3000`). Sets `isLocal = true` when URL host is `localhost`, `127.0.0.1`, `0.0.0.0`, or `::1`. Empty env → `{ url: "http://localhost:3000", isLocal: true }`.
- [x] **8.2** New API endpoint `GET /api/config/public-url` returns `{ url, isLocal }` so the client doesn't need direct env access.
- [x] **8.3** Modified `WebhookPrompt.tsx` to fetch `/api/config/public-url` on mount. When `isLocal=true`: shows amber-bordered Cloudflare Tunnel setup panel (cloudflared command with copy button, GREPLOOP_PUBLIC_URL instruction) above the auto/manual webhook buttons. When `isLocal=false`: shows green "Public URL configured" confirmation, skips tunnel steps entirely.
- [x] **Verify:** Typecheck clean. All 33 tests pass. Tunnel panel renders on localhost, hidden when GREPLOOP_PUBLIC_URL points at a public host.

## Discovered during work

- 4 crypto tests in `tests/crypto.test.ts` — encrypt/decrypt round-trip, hasMasterKey true/false, wrong tag rejection.
- **Bug fix (2026-06-23):** Yellow "INDEX NOW" banner on the PRs view only switched tabs without triggering the indexer. Extracted into `src/components/views/prs/IndexNowBanner.tsx` — now POSTs to `/api/repos/{id}/index`, polls `/api/repos/{id}` every 5s until `indexedAt` appears, then auto-dismisses. PrsView drops the `onGoToIndexing` prop in favor of `repoId` + `onIndexComplete`.
