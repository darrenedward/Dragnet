# PRD: Per-Project API Keys

## Problem Statement

Dragnet currently has a confusing API key system. There are global "master" API keys that don't identify which project is being called, alongside two overlapping config files (`.dragnet/repo.json` and `.dragnet/cred.json`), a `.dragnet/repo-id` marker file, and three env vars (`DRAGNET_API_KEY`, `DRAGNET_URL`, `DRAGNET_REPO_ID`). The `ApiKey` model already has a `repoId` field, but the server never enforces it — a repo-scoped key and a global key authenticate identically. This makes it unclear which project a caller is acting on, and the `.dragnet/` filesystem approach creates a sync problem when Dragnet runs remotely (VPS, same-network server, or Docker container).

## Solution

Each project gets its own API key, auto-generated at project creation time. The key itself identifies the project on the server — no separate `repoId` is needed at the caller level. Client configuration collapses to two env vars: `DRAGNET_API_KEY` (the per-project key) and `DRAGNET_URL` (the Dragnet server address). The `.dragnet/` filesystem convention (`repo.json`, `cred.json`, `repo-id`) is removed. GitHub becomes the primary connection layer — remote GitHub repos work identically whether Dragnet runs locally, on the same network, or on a VPS.

## User Stories

1. As a Dragnet admin, I want each project to have its own API key auto-generated when I add the project, so that each key identifies a specific project without manual setup.
2. As a Dragnet admin, I want to see and copy a project's API key from the project settings (cog icon), so that I can configure client-side tooling.
3. As a developer, I want to set `DRAGNET_API_KEY` and `DRAGNET_URL` in my `.env` file and have the agent skill / pre-push hook work, so that I don't need to manage `.dragnet/` config files.
4. As a developer using Claude Code, I want `/dragnet` commands to work by reading `$DRAGNET_API_KEY` from my environment, so that I don't need to install config files in my repo.
5. As a Dragnet admin, I want the InstallModal to show `export DRAGNET_API_KEY=dr_xxx` and `DRAGNET_URL=http://...` without `.dragnet/` file instructions, so that setup is simpler and works across any Dragnet deployment mode.
6. As a Dragnet admin, I want a repo-scoped API key to only access its own project's data, so that a leaked key doesn't expose other projects.
7. As a Dragnet admin, I want the existing API Keys panel in Settings to remain available for generating standalone keys, so that I can still create keys for CI/other tooling.
8. As a Dragnet operator, I want the Docker container to run without needing `DRAGNET_API_KEY` set in `.env.local`, so that server configuration stays minimal.
9. As a developer, I want the pre-push hook to read `$DRAGNET_API_KEY` from the environment (no file fallback), so that it works consistently across CI and local dev.
10. As a developer, I want `dragnet-init` CLI to be removed or simplified to just provide the API key via env var, so that there's one less tool to maintain.

## Implementation Decisions

### Schema
- `ApiKey.repoId` already exists and is nullable. No schema changes needed.
- `ApiKey.name` is repurposed: when auto-generated for a project, name becomes `project:<repo.name>`.

### API Changes

**POST `/api/keys`** — Accept optional `repoId` in body. When `repoId` is provided, the generated key is scoped to that repo. When omitted, creates a global key (for CI/admin use).

**POST `/api/repos`** — On successful repo creation, auto-generate a repo-scoped API key and include `{ apiKey: raw, apiKeyPrefix: prefix }` in the response. The raw key is shown once.

**GET `/api/repos/[id]`** — Include `{ apiKeyPrefix }` in the response so the UI can show which key is associated.

### Auth Enforcement (`src/lib/apiAuth.ts`)

**`authenticateApiRequest`** — After hash lookup, if `key.repoId` is set, store `key.repoId` on the request context so downstream route handlers can enforce scoping.

Per-repo route handlers (`/api/repos/[id]/...`, `/api/prs/[prId]/...`, `/api/repos/[id]/symbols`, etc.) — Check that the authenticated key's `repoId` (if set) matches the target repo's ID. Reject with 403 if they don't match. Global keys (no `repoId`) continue to have unrestricted access.

### Client Config Removal

- `.dragnet/repo.json` — Remove from codebase. `dragnet-init` CLI no longer writes it.
- `.dragnet/cred.json` — Remove from codebase. Agent skill no longer reads it.
- `.dragnet/repo-id` — Remove from codebase. The server no longer writes it.
- Agent skill (`SKILL.md`) — Collapse discovery chain to `$DRAGNET_API_KEY` + `$DRAGNET_URL` only. Remove `.dragnet/` file reads.
- Pre-push hook (`scripts/hooks/pre-push`) — Remove the `.dragnet/cred.json` fallback. Require `$DRAGNET_API_KEY`.
- InstallModal (`ApiKeysPanel.tsx`) — Show `export DRAGNET_API_KEY=dr_xxx` and `DRAGNET_URL=http://...` commands. Remove references to writing `.dragnet/` files.

### UI Changes

- **AddRepoModal** — After successful repo creation, show the auto-generated API key once in a banner (like the existing key-created-once pattern).
- **RepoSettingsModal** (cog icon) — Add an "API Key" section showing the key prefix and a "Copy" / "Regenerate" button. Regenerate revokes the old key and creates a new one.
- **ApiKeysPanel** — Keep the existing panel for global key management. Remove the "Target Repository" dropdown and "Connect Your Tools" section that writes `.dragnet/` files (the key display is now per-project).

## Testing Decisions

- **What makes a good test**: Test external behavior — a key with `repoId=A` can access repo A's data but gets 403 on repo B's data. Test that global keys (no `repoId`) still access everything. Test that revoked keys are rejected regardless of scoping. Do NOT test implementation details of the hashing or DB query layer.
- **`tests/apiAuth.test.ts`** (new) — Unit test `authenticateApiRequest` with a mocked Prisma client. Test three scenarios: (1) repo-scoped key accessing its own repo, (2) repo-scoped key accessing a different repo, (3) global key accessing any repo. Prior art: `tests/auth.test.ts` for import pattern, `tests/crypto.test.ts` for mocking pattern.
- **`tests/keysRoute.test.ts`** (new) — Test `POST /api/keys` with and without `repoId` body param. Verify the created key's `repoId` field in the DB. Prior art: `tests/webhookRoute.test.ts` for route handler testing.

## Out of Scope

- Removing global API keys entirely. Global keys are still useful for CI/CD pipelines, admin automation, and multi-project tools.
- GitHub OAuth changes. The remote GitHub connection flow remains as-is.
- Multi-tenant isolation beyond the `ApiKey.repoId` enforcement. True organization-level scoping is future work.
- The MCP server — already removed in favor of skills/slash commands.
- Migration of existing keys. Existing global keys continue to work. Newly added projects get scoped keys.

## Further Notes

- The `repo.json`/`cred.json`/`repo-id` confusion was an artifact of evolving from a local-only tool to a remote server. This PRD cleans that up.
- Server-side enforcement of `key.repoId` means a leaked key only exposes its project, which is the minimum bar for multi-tenant readiness.
- The Docker container doesn't need `DRAGNET_API_KEY` in its environment — that's purely for external callers. The server's own polling worker uses `DRAGNET_API_KEY` only when `DRAGNET_POLLING_ENABLED` is on, which is optional.
