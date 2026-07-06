# Tasks — Hosted Scan Architecture

**Spec:** 2026-07-03-0900-hosted-scan-architecture
**Plan:** plan.md in this directory

Tasks are organized by implementation phase. Each phase corresponds to one vertical-slice issue. Do not start a later phase until blockers are merged.

## GitHub Issues

| # | Title | Status |
|---|-------|--------|
| #11 | Slice 1: Repo Identity by Canonical URL | `ready-for-agent` |
| #14 | Slice 2: Scan State Centralization | `ready-for-agent` |
| #15 | Slice 3: GitHub App OAuth + HTTPS Clone | `ready-for-agent` |
| #12 | Slice 4: Buildsystem Detector + Tier 2 Gate Rules | `ready-for-agent` |
| #16 | Slice 5: dragnet init CLI | `ready-for-agent` |
| #13 | Slice 6: systemd + Deployment Hardening | `ready-for-agent` |
| #17 | Slice 7: Webhook Integration + AFK Scan | `ready-for-agent` |

## Phase 1 — Identity & schema (foundation) (DONE — commits 60b275b, 2e57d03, 5a963f7, 9197206, 785e36e)

- [x] Define canonicalization rules in `src/lib/repoIdentity.ts`
- [x] Add unit tests for all SSH/HTTPS URL variants (see plan §Identity Model)
- [x] Add `repoId`, `canonicalRemote`, `installationId` columns to Repository model
- [x] Add Prisma migration
- [x] Backfill `repoId` for existing repos from `path` / `cloneUrl`
- [x] Implement `POST /api/repos/lookup` endpoint
- [x] Add unique index on `repoId`
- [x] Update `POST /api/repos` to compute and store canonical `repoId`

### Container runner schema (added alongside Phase 1)

- [x] Add `runnerImage`, `installCommand`, `testCommand`, `isPollingEnabled` to Repository model

## Phase 2 — Scan state centralization (DONE — de82f9b)

- [x] Add `getScanStatePath(repoId)` helper in `src/lib/scanStatePath.ts`
- [x] Migrate `src/services/checkpointStore.ts` to central path
- [x] Migrate `src/services/largePrReview/reportLogger.ts` to central path
- [x] Migrate `src/lib/providerHealth.ts` to central path
- [x] Migrate review-limits reader (`src/services/largePrReview/manifest.ts`)
- [x] One-time migration script: move existing per-repo `.dragnet/{checkpoints,reports,reviews}` to `/var/lib/dragnet/scans/<repoId>/`
- [x] Update `docker-compose.yml`: remove `:ro` blocker where applicable, add `/var/lib/dragnet` volume
- [x] E2E test: full scan produces state in central path, not per-repo

## Phase 3 — GitHub App OAuth (DONE — commits 1039f66, 3e4a69d, c822ec8, 687bb27, 4b8e345)

- [x] Create GitHub App (manual, one-time setup; document in deployment guide)
- [x] Add `OAuthConnection` model to Prisma schema
- [x] Add migration
- [x] Implement `src/lib/githubApp.ts`: JWT signing, installation token fetch, cache + refresh
- [x] Implement `GET /api/github/oauth/start` — redirect to GitHub
- [x] Implement `GET /api/github/oauth/callback` — exchange code, store installation ID
- [x] Implement HTTPS clone using installation token
- [x] UI: "Connect GitHub" button on Repos page
- [x] UI: Repo picker dropdown (lists repos App is installed on)
- [x] UI: "Disconnect" button
- [x] Tests: OAuth flow with mocked GitHub API
- [x] Tests: token refresh on expiry
- [x] Tests: clone succeeds with installation token

## Phase 4 — Podman Tier 2 pipeline

- [x] Define podman invocation contract (`src/lib/containerOrchestrator.ts` + `src/services/deterministicChecks/containerRunner.ts`)
- [x] Output capture (stdout, stderr, exit code, structured test results where available)
- [x] Normalize Tier 2 output into AI scan input shape (tsc/eslint parsers in `parsers.ts`)
- [x] Network default: no network access (`--network=none`); git sync uses `--network=bridge`
- [x] CPU/memory limits per build (`--cpus=2`, `--memory=4g`)
- [x] Tests: install + test pass returns empty findings
- [x] Tests: tsc diagnostics parsed from test stdout
- [x] Tests: eslint JSON output parsed from test stdout
- [x] Tests: build failure captured correctly (exit code + unparseable output)
- [x] Tests: test command timeout handled gracefully
- [x] Tests: git sync failure returns skipped finding
- [x] Tests: custom runnerImage and commands
- [x] Implement buildsystem detector (`src/lib/buildsystemDetect.ts`) — recognize package.json, Cargo.toml, pyproject.toml, etc.
- [x] Per-language base image manifests (currently image is configured per-repo)
- [x] Implement gate rules: skip Tier 2 if Tier 1 fails, skip Tier 3 if Tier 1+2 clean and diff trivial
- [x] Per-repo override setting ("skip Tier 2")
- [x] Tests: unit tests for detection paths (11) + gate rule combinations (20) + diff classifier (20)
- [ ] Tests: sample Rust repo build *(manual — needs Podman/Docker)*
- [ ] Tests: sample Python repo build *(manual — needs Podman/Docker)*
- [ ] Tests: malicious build script cannot reach network *(manual — needs Podman/Docker)*

## Phase 5 — `dragnet init` CLI (DONE — 57b088a)

- [x] Create `cli/dragnet-init` package
- [x] Implement `git remote get-url origin` reader
- [x] Implement canonicalization (shared with `src/lib/repoIdentity.ts`)
- [x] Implement `/api/repos/lookup` call
- [x] Implement `.dragnet/repo.json` writer
- [x] Handle pure-local fallback (prompt user to paste repoId)
- [x] Add `.dragnet/repo.json` to `.gitignore` automatically (with prompt)
- [x] Distribute via `npx dragnet-init`
- [x] Tests: CLI invocation in repo with remote
- [x] Tests: CLI invocation in pure-local repo
- [x] Tests: graceful failure when Dragnet unreachable

## Phase 6 — systemd + deployment hardening (DONE — 23b6501, fe28fad)

- [x] Write `deployment/dragnet.service` systemd unit with hardening block
- [x] Write `deployment/install.sh` — creates dragnet user, sets permissions
- [x] Write master key generation tool (`src/tools/generateMasterKey.ts`)
- [x] Write master key rotation tool (`src/tools/rotateMasterKey.ts`)
- [x] Document VPS deployment in `docs/deployment.md`
- [x] Podman rootless setup verification script
- [x] Verify: container escape lands as dragnet user, not root
- [x] Verify: master.key mode 400, owner dragnet:dragnet

## Phase 7 — Webhook integration (DONE — commits cea9199, f71b104, 0162478)

- [x] Implement GitHub webhook signature verification (HMAC SHA-256)
- [x] Implement `POST /api/github/webhook` endpoint
- [x] Handle `pull_request` event → trigger AFK scan
- [x] Handle `push` event → trigger AFK scan of affected branches
- [x] UI: per-repo webhook enable/disable
- [x] UI: display webhook delivery history (optional)
- [x] Tests: webhook signature validation (valid + invalid)
- [x] Tests: pull_request event triggers scan
- [x] Tests: replay attack rejected

### Sidecar: PR polling worker (firewalled environments)

- [x] Implement `src/lib/prPollingWorker.ts` — polls GitHub API for PR commit changes
- [x] ETag-based rate limit avoidance (304 → skip)
- [x] Wire into `src/instrumentation.ts` (opt-in via `DRAGNET_POLLING_ENABLED=1`)
- [x] Update `reviewService.ts` to use containerized checks for remote repos
- [x] Implement volume prune command (`npm run dragnet prune-volumes`)

## Tracked as GitHub issue

- [x] Created as [issue #45](https://github.com/darrenedwardhouseofjones/Dragnet/issues/45) with `ready-for-agent` label.

## Out of scope (deferred)

- GitLab OAuth App (Phase 8+, post-launch)
- Bitbucket OAuth App
- Self-hosted GitHub Enterprise support
- Multi-user / multi-tenant
- VS Code / JetBrains plugins
- Per-repo Tier 2 cache (Nix-style content-addressed)
