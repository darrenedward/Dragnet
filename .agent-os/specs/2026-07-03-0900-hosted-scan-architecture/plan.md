# Hosted Scan Architecture

## Goal

Allow Dragnet to run scans on external repos via a hosted service. External repos authenticate with `hs_` scan tokens, trigger scans by API or webhook, and Dragnet discovers PRs proactively via an outbound poller.

## Dependency chain

```
#45 Schema: ScanToken + Repository.hostedMode + WebhookDelivery
 └→ Scan token service (generate, hash, authenticate, revoke, list)
 └→ Scan orchestrator (validateHostedMode, triggerHostedScan)
 └→ API routes: POST /api/hosted-scan/scan, tokens CRUD, webhook-info
 └→ UI: ScanTokensSection, hosted mode toggle in EditRepo
 └→ Webhook delivery logging (GitHub + GitLab webhook routes)
 └→ Outbound poller (#46): periodic PR discovery from GitHub/GitLab APIs
```

## Key decisions

- `hostedMode` flag on `Repository` — toggle between local and hosted scan modes.
- `ScanToken` model with `hs_` prefix, SHA-256 hashed at rest, one-show raw value.
- `authenticateScanToken()` validates `hs_` prefix, hashes, checks `revoked`, lazily updates `lastUsedAt` (5 min cooldown).
- `triggerHostedScan()` upserts PullRequest by `(repoId, sourceBranch, targetBranch)`, calls `runPrScan()`.
- Webhooks (GitHub pull_request, GitLab Merge Request Hook) call `triggerHostedScan` when `hostedMode=true`.
- `WebhookDelivery` model stores delivery logs with `hostedMode` flag for replay detection.
- Outbound poller (`poller.ts`) queries GitHub/GitLab APIs for open PRs on repos with `isPollingEnabled=true`. Configurable interval (default 120s).
- Provider adapters behind `ProviderAdapter` interface (`fetchPrs` method) for GitHub and GitLab.
- Branch pattern filtering per repo via shell-glob (`*` wildcard).
- No local clone required in hosted mode — webhook payloads or poller API responses provide all PR data.
