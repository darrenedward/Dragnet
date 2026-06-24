# Plan — Security Fixes from AI Code Review

## Context

After landing the index-freshness-gates spec, the user kicked off an AI code review of the current branch (`feature/bug-demo`). 8 findings came back. After verification, 6 were real and 2 were false positives. This spec covers the 4 fixes that shipped in commit `2e4113e`.

The goal: close real auth/isolation/hygiene gaps without breaking existing callers or tearing up working code.

---

## Finding #1 — Host-header auth bypass (CRITICAL)

**Symptom:** `authenticateIfExternal` trusted the HTTP/1.1 `Host` header to decide whether to enforce auth. Any TCP client sending `Host: localhost:3300` bypassed auth on three route handlers:
- `GET /api/repos/[id]/stats`
- `POST /api/repos/[id]/reindex`
- `GET / POST / DELETE /api/repos/[id]/webhook`

**Root cause:** the Host header is attacker-controllable. Treating it as a source of truth for "is this request internal?" is broken at the protocol level.

**Fix:** replaced with `authenticateSessionOrKey` which validates either:
1. `Authorization: Bearer gl_…` — real DB lookup against `api_keys` (hash, revocation, lastUsedAt touch).
2. Session cookie — Better Auth's `requireSession` verifies the cookie against the `sessions` table.

No host heuristics. Updated all 5 call sites + removed `authenticateIfExternal` from `apiAuth.ts`.

---

## Finding #4 — Cross-repo PR leak (HIGH)

**Symptom:** `findPrByIdOrNumber` did fuzzy/ordinal/substring matching with no `repoId` scope. A CLI caller with a key for repo A could pass `number: "1"` and resolve a PR from repo B.

**Root cause:** the function tried multiple resolution strategies (exact ID, `pr-N`, endsWith, ordinal by createdAt, contains). None of them were scoped.

**Fix:** made `repoId` a required parameter for any non-exact-ID matching:
- Exact ID lookup stays universal (IDs are globally unique).
- Ordinal/endsWith/contains matching is gated behind a `repoId` argument.
- Without `repoId`, the function returns `null` for non-exact matches.

Updated all callers to pass `repoId` from their args/query/context. Path-based routes (`/api/prcheck/[prIdOrNumber]`, `/api/prcomments/[prIdOrNumber]`) now accept `?repoId=` for callers that have it.

---

## Finding #6 — Misleading reindex response (MEDIUM)

**Symptom:** `POST /api/repos/[id]/reindex` returned `{success: true}` synchronously while the actual indexing ran fire-and-forget in a Promise chain. Callers had no way to know if the work succeeded, failed, or was still running.

**Root cause:** premature success reporting.

**Fix:** return `202 Accepted` with `status:"stabilizing"` and a pointer to the polling endpoint. The async work is unchanged — only the response contract is honest now.

---

## Finding #3 — Predictable SSH key path (MEDIUM)

**Symptom:** `buildSshEnv` wrote deploy keys to `/tmp/greploop-deploykey-<keyId>` with a predictable filename. Two attack surfaces:
1. Attacker pre-creates the file as a symlink to a victim's sensitive file → key write goes there.
2. Process crash between `writeFileSync` and `unlinkSync` leaves the key on disk.

**Root cause:** `mkdtempSync` exists precisely for this; we weren't using it.

**Fix:** switched to `mkdtempSync(path.join(os.tmpdir(), "greploop-key-"))` which creates a private, unpredictable directory. `chmod 0o700` defensively. Cleanup now does both `unlinkSync(keyFile)` and `rmdirSync(keyDir)`.

---

## Out of scope

- **#7 delete+create race** in `getRealLocalPrs.ts:163` — flagged as separate work.
- **#5 proxy blocks UI fetches** — false positive (`getSessionCookie` does cookie-presence check before signature validation).
- **#8 webhook URL injection** — false positive (`getProviderFromUrl` only returns `"github"` or `"gitlab"`).
