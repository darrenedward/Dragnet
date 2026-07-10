# Tasks — Hosted Scan Architecture

Update status as work progresses. Mark each `[x]` only when work is actually done.

## Phase 1 — Schema

- [x] 1.1 Add `hostedMode Boolean @default(false)` to `Repository` model. Prisma migrate.
- [x] 1.2 Add `isPollingEnabled Boolean @default(false)` to `Repository` model.
- [x] 1.3 Add `ScanToken` model: `id, repoId, label, prefix, hash (unique), createdAt, lastUsedAt, revoked`. Cascade delete on repo. `@@map("scan_tokens")`.
- [x] 1.4 Add `WebhookDelivery` model: `id, repoId, provider, eventType, deliveryGuid, status, hostedMode, prNumber, error, createdAt, completedAt`. Indices on `(repoId, createdAt)`, `deliveryGuid`, `status`. `@@map("webhook_deliveries")`.
- [x] 1.5 `npx prisma db push` clean.

## Phase 2 — Scan token service

- [x] 2.1 `src/services/hostedScan/scanToken.ts`: `generateScanTokenRaw()` — `hs_` prefix + 32 random hex bytes. Returns `{ raw, prefix, hash }`.
- [x] 2.2 `hashScanToken(raw)` — SHA-256, rejects non-`hs_` prefixes.
- [x] 2.3 `createScanToken(repoId, label)` — validates hosted mode, persists hash, returns raw token.
- [x] 2.4 `authenticateScanToken(raw)` — hash lookup, revoked check, lazy `lastUsedAt` update.
- [x] 2.5 `revokeScanToken(id)` — soft-delete via `revoked = true`.
- [x] 2.6 `listScanTokens(repoId)` — ordered by createdAt desc.
- [x] 2.7 Barrel export via `src/services/hostedScan/index.ts`.

## Phase 3 — Scan orchestrator

- [x] 3.1 `src/services/hostedScan/orchestrator.ts`: `validateHostedMode(repoId)` — checks repo exists + `hostedMode=true`.
- [x] 3.2 `HostedPrData` interface: `prNumber, title, headBranch, baseBranch, commitHash, author?, description?`.
- [x] 3.3 `HostedScanResult` discriminated union: `{ ok: true, prId, runId? } | { ok: false, error }`.
- [x] 3.4 `triggerHostedScan(repoId, data)` — upserts PR by `(repoId, sourceBranch, targetBranch)`, calls `runPrScan()`.
- [x] 3.5 Barrel export.

## Phase 4 — API routes

- [x] 4.1 `POST /api/hosted-scan/scan` — Bearer `hs_` token auth, body validation, calls `triggerHostedScan`. Returns `{ ok, prId, runId }` or 401/400.
- [x] 4.2 `GET /api/hosted-scan/tokens?repoId=xxx` — list scan tokens (session/API key auth).
- [x] 4.3 `POST /api/hosted-scan/tokens` — create scan token, returns raw value once (session/API key auth).
- [x] 4.4 `DELETE /api/hosted-scan/tokens/{id}` — revoke scan token (session/API key auth).
- [x] 4.5 `GET /api/hosted-scan/webhook-info` — returns GitHub/GitLab webhook setup instructions.

## Phase 5 — UI

- [x] 5.1 `ScanTokensSection.tsx` in RepoSettingsModal: token list, create with label input, one-time raw token display (amber banner), revoke.
- [x] 5.2 Hosted mode checkbox in EditRepoModal with explanatory text.
- [x] 5.3 Loading, empty, error states for token management UI.

## Phase 6 — Webhook delivery logging

- [x] 6.1 `src/lib/webhookDelivery.ts`: `createDeliveryLog(repoId, provider, eventType, deliveryGuid)`, `updateDeliveryStatus(id, status, error?)`, `checkDelivery(deliveryGuid)`.
- [x] 6.2 GitHub webhook route: routes `pull_request` events through `triggerHostedScan` when `hostedMode=true`; logs all deliveries.
- [x] 6.3 GitLab webhook route: same pattern for `Merge Request Hook` events.
- [x] 6.4 `findRepoByCloneUrl` returns `hostedMode` flag.

## Phase 7 — Outbound poller (#46)

- [x] 7.1 `src/services/hostedScan/poller.ts`: `ProviderAdapter` interface with `fetchPrs()` method.
- [x] 7.2 `githubAdapter`: calls `GET /repos/{owner}/{repo}/pulls?state=open` with Bearer PAT auth.
- [x] 7.3 `gitlabAdapter`: calls `GET /api/v4/projects/{encoded}/merge_requests?state=opened` with `PRIVATE-TOKEN` auth.
- [x] 7.4 `parseOwnerRepo(cloneUrl)`: extract owner/repo from SSH or HTTPS URLs.
- [x] 7.5 `getPat(repo)`: decrypt stored PAT ciphertext.
- [x] 7.6 `matchBranchPattern(branch, pattern)`: shell-glob matching, default `"*"`.
- [x] 7.7 `syncPr(repoId, item)`: upsert PR, skip if commit hash unchanged.
- [x] 7.8 `pollHostedRepos()`: iterate repos with `hostedMode=true AND isPollingEnabled=true`, fetch PRs, filter, sync, trigger scans.
- [x] 7.9 `startHostedPoller()` / `stopHostedPoller()`: singleton interval lifecycle.
- [x] 7.10 Integration in `src/instrumentation.ts` gated by `DRAGNET_HOSTED_POLLING_ENABLED=1`.

## Testing

- [x] 8.1 `tests/hostedScan/scanToken.test.ts`: token generation format, deterministic hashing, prefix rejection, uniqueness, tamper detection (5 tests).
- [x] 8.2 `tests/hostedScan/orchestrator.test.ts`: `HostedPrData` field acceptance, `HostedScanResult` discriminated union (2 tests).
- [x] 8.3 `tests/hostedScan/api.test.ts`: scan endpoint auth and validation, token CRUD shape (13 tests).
- [x] 8.4 `tests/hostedScan/poller.test.ts`: empty repos, provider filtering, GitHub PR discovery, skip-on-unchanged, re-scan-on-change, branch filtering, API errors, multi-repo, no clone URL, GitLab, error reporting, lifecycle (17 tests).
- [x] 8.5 `tests/webhookDelivery.test.ts`: create delivery, update status, duplicate replay detection, hosted mode flag (5 tests).
- [x] 8.6 `tests/webhookRoute.test.ts`: GitHub webhook hosted mode path (26 tests).
- [x] 8.7 `tests/webhookGitlabRoute.test.ts`: GitLab webhook hosted mode path (27 tests).
- [x] 8.8 Full suite green + `tsc --noEmit` clean.

## Ship

- [x] 9.1 `npm run lint` (tsc --noEmit) passes.
- [x] 9.2 `npm run build` passes.
- [x] 9.3 `npx vitest run` — full suite green.
- [x] 9.4 Shipped to `main` in 3 commits: `b2ebec2` (Phase 1-5), `c4bab84` (Phase 6), `d1dc976` (Phase 7).

## Tracked as GitHub issues

- [x] #45 — Hosted Scan Architecture (Phases 1-6)
- [x] #46 — Outbound Scan Poller (Phase 7)
- [x] #47 — Webhook Hosted Mode Support (Phase 6)

## Blockers / open questions

- None — shipped to main.
