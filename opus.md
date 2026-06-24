
Session review of the GrepLoop workflow (self-hosted Greptile/CodeRabbit
alternative). Covers one UI fix delivered this session plus a full
end-to-end review of the PR-review pipeline with prioritized issues.

---

## 1. UI fix delivered — center PR-review column scroll

**Symptom:** On the Interactive PR / Diff Scanner, the center column
(PR header → Review Progress → AI findings → History) was clipped with no
page scrollbar; panels looked squashed below the `xl` (1280px) breakpoint.

**Root cause:** In `src/components/views/PrsView.tsx` the root was
`overflow-hidden` at all sizes and only the left column scrolled
(`overflow-y-auto`), while `FilesPanel` was `shrink-0`. When the two panels
stack vertically (below `xl`), the non-shrinking FilesPanel claimed its full
height and squeezed the findings column into a sliver. A first patch made it
worse: leaving `overflow-x-hidden` + `flex-1` + `min-h-0` active below `xl`
promoted computed `overflow-y` to `auto` and let the column collapse to
`clientH: 0`, hiding the findings entirely.

**Fix (two class changes):**
- Root: `overflow-hidden` → `overflow-y-auto xl:overflow-hidden`
- Center column: made `flex-1`, overflow, and `min-h-0` all `xl:`-only, so
  below `xl` it is a natural-height block and the whole view scrolls as one
  page; at `xl`+ the two-pane independent scroll is preserved.

**Verified** via a class-identical static harness at 1024px (whole-page
scroll, all 9 findings + Files panel reachable) and 1440px (independent
two-pane scroll, diff panel keeps its own `max-h` scroll).

---

## 2. Workflow review — issues & bugs (prioritized)

### 🔴 Critical

**C1 — Almost the entire API is unauthenticated.**
The `/login` redirect in `src/app/page.tsx` only guards the HTML page. There
is no `proxy.ts`/`middleware.ts`, so each route must guard itself — and only
4 of 31 do (`hooks/prepush`, `command`, `prcheck`, `prcomments`
via `authenticateApiRequest`). High-value open endpoints:

| Endpoint | Unauth impact |
|---|---|
| `POST /api/keys` | Mint a valid `gl_` API key, then use the "authed" API-key endpoints |
| `PUT /api/llm/presets` | Repoint chat/embedding endpoint → exfiltrate reviewed code; inject key |
| `POST /api/db/config` | Rewrite DB connection string in `.env.local` |
| `GET /api/fs/list` | Browse the server filesystem |
| `POST /api/repos`, `…/index`, `…/reindex` | Trigger server-side `git` exec + indexing (DoS) |
| `POST /api/prs/[prId]/scan` | Trigger expensive LLM scans (cost/DoS) |
| `/api/repos/[id]/symbols`, `/reviews`, `findings` | Read all tenant data |

Legitimately open: `/api/auth/*`, `/api/webhooks/*` (HMAC-verified —
`verifyGithubSignature` is correctly wired). **Fix:** add `src/proxy.ts`
(see §3) plus per-route `requireSession()` on secret-handling routes.

**C2 — "Multi-tenant" is not enforced.**
Org plugin tables exist (`Organization`, `Member`), but no domain model
carries `organizationId`/`userId`: `Repository`, `PullRequest`, `Symbol`,
`ReviewFinding`, `ReviewHistory`, `McpApiKey` are all global. Every logged-in
user sees/acts on every repo; API keys aren't scoped. Contradicts the
PRD/CLAUDE.md multi-tenant claim. **Fix:** add `organizationId` to those
models, scope every query, attach `McpApiKey` to an org/user.

### 🟠 High — indexing/embedding path

**H3 — Embedding column dimension contradicts the documented model.**
Schema hardcodes `embedding Unsupported("vector(1536)")`. The troubleshooting
doc tells users to `ollama pull mxbai-embed-large` (1024-dim; Cohere/Voyage
also 1024). Casting a 1024-dim array to `vector(1536)` errors on every
enrichment UPDATE, so `embedding` stays NULL and `semanticSearch` always
returns `[]`. Likely the real cause of "embeddings never populate" — not just
a missing llama binary. **Fix:** standardize on a 1536-dim model or make the
dimension configurable and validate at write time.

**H4 — A failed embedding aborts the whole enrichment pass and drops the summary.**
In `indexingService.startBackgroundEnrichment`, when the embedding circuit is
open `generateEmbedding` returns `[]` → `"[]"::vector` throws → outer `catch`
deletes `activeEnrichers` and **stops enrichment**; the atomic UPDATE also
means the summary is never saved, so the symbol retries forever. **Fix:** if
`vector.length === 0`, persist the summary alone and `continue`.

**H5 — Infinite background loop on empty summaries.**
If `generateSummary` returns `""`, nothing is written, the symbol stays
`summary: null`, and the recursive enrichment re-fetches the same 100 rows
forever, burning a chat call every 2s. **Fix:** track attempts / a sentinel
so unenrichable symbols aren't reselected indefinitely.

### 🟡 Medium

**M6 — Pre-push gate misreports LLM outages as code failures.**
`hooks/prepush`: `passed = result.rating >= 8`. When the LLM chain fails,
`rating` is `null` → `null >= 8` is `false` → push blocked with
`"rating null/10 (requires 8+)"` and `systemWarn` is discarded. **Fix:**
branch on `systemWarn`/`rating === null`, surface it, and decide fail-open vs
fail-closed explicitly.

**M7 — In-app scan route skips the command-route concurrency guard.** ✅ Fixed.
`POST /api/prs/[prId]/scan` didn't use the `activeReviews` dedupe the command
route uses. Concurrent scans raced `reviewFinding.deleteMany`→`createMany`,
double-incremented `reviewsCount`, and duplicated `reviewHistory`. **Fix
applied:** extracted the tracker into `src/lib/reviewLocks.ts`
(`isReviewActive`/`beginReview`/`endReview`) shared by both the command route and
the scan route; the scan route now returns 409 on a duplicate and releases
only the lock it actually acquired (`acquired` flag).

**M8 — Off-enum severities persist but never render.**
The schema isn't strict; a model can return a `severity` outside
`{blocker, warning, suggestion}`. `runPrScan` stores it verbatim but
`ReviewCard` only renders `severityOrder` groups, so the header count
("Findings (9)") can exceed what's shown. **Fix:** normalize `severity`/
`category` to the enums at persistence.

### 🟢 Low / polish

- **Rating coercion hides zeros:** `Math.min(10, finalReview.rating || 5)`
  turns a returned `0`/omitted rating into a middling `5`. Use `?? 5`.
- **No token budgeting:** per-file `MAX_FILE_CHARS = 10000` + `max_tokens:
  4096`, no total token count → large PRs can exceed the context window and
  400, counted as a provider "failure".
- **Stale comment** in `reviewService.ts` ("Falls through to procedural
  findings…") contradicts the current honest-empty behavior.
- **`webhookSecret` stored plaintext** (schema-acknowledged; needed for HMAC
  verify). The one secret not encrypted via `crypto.ts` — document or
  encrypt-at-rest with decrypt-on-verify.

---

## 3. Next.js 16: use `proxy.ts`, not `middleware.ts`

`middleware.ts` is deprecated in Next.js 16; the convention is now
`src/proxy.ts` exporting `proxy` (Vercel PR #84119). It's a drop-in rename —
codemod: `npx @next/codemod@latest middleware-to-proxy .`.

**Caveat for the auth gate (C1):** the proxy runs at the network boundary
(potentially the Edge runtime), where Prisma (Node-only) can't run, so do a
**lightweight cookie check** there (Better Auth's `getSessionCookie`) for the
redirect/401, and keep real DB-backed session validation in the Node route
handlers via `requireSession()`. A `matcher` config scoping `/api/:path*`
(excluding `/api/auth`, `/api/webhooks`) is recommended.

---

## 4. Recommended remediation order

1. **C1** — `src/proxy.ts` session gate for `/api/*` + `requireSession()` on
   secret routes. Biggest exposure, smallest change.
2. **H3 + H4** — embedding dimension + empty-vector/summary-drop guard. This
   is what makes "review has codebase context" actually work.
3. **M6** — prepush null-rating handling so the git gate is trustworthy.
4. **C2** — multi-tenancy scoping (schema migration; larger).
5. Remaining medium/low items.

---

## 5. Status

- ✅ Center-column scroll fix applied (`PrsView.tsx`) and verified.
- ✅ **C1** — `src/proxy.ts` session gate added (Next 16 `proxy` export +
  matcher excluding `auth`/`webhooks`/`hooks`/bearer-key `command`/`prcheck`/`prcomments`).
  `requireSession()` added to `keys`, `db/config`, `llm/presets` (PUT),
  `fs/list`.
- ✅ **H4/H5** — enrichment now persists the summary when embedding is empty
  and stamps `summaryAt` so failed symbols aren't reselected forever.
- ✅ **M6** — prepush returns 503 + the real `systemWarn` (via `error`) on a
  null rating instead of a bogus "rating null/10" block.
- ✅ **M8 + rating** — severity/category clamped to enums at persistence;
  rating coercion uses `?? 5` (preserves a genuine 0).
- ✅ Stale "procedural findings" doc comment in `reviewService.ts` removed.
- ✅ **M7** — scan-route concurrency guard via shared `src/lib/reviewLocks.ts`.
- ⏳ **Not done (still open):** C2 multi-tenancy scoping (schema migration),
  H3 embedding dimension mismatch (`vector(1536)` vs 1024-dim models) —
  needs a design call (lock to a 1536-dim model vs. configurable dimension)
  before a schema migration, token budgeting, `webhookSecret` at-rest.

### Pre-existing issues found while implementing (untouched, not introduced here)

- ✅ **`repos/[id]/stats/route.ts`** — `prisma.symbol.count({ where: {
  embedding: { not: null } } })` failed `tsc` (and at runtime): `embedding`
  is a Prisma `Unsupported` column and can't be used in `where`. Fixed —
  replaced with a `$queryRaw` `COUNT(*) … WHERE embedding IS NOT NULL`.
  `npm run lint` now passes clean.
- ✅ **`scripts/hooks/pre-push:43`** — the `curl -d` JSON body was missing
  its closing `}` (`…\"sha\":\"$local_sha\""`), so the prepush request body
  was malformed and the route fell back to `{}` → 400. Fixed — added the
  closing brace so the hook can actually post a valid body.

---

## 6. PRD alignment update — tree-sitter and false-positive controls

Follow-up review of the current codebase against `prd.md` found that the
architecture is directionally aligned but still below the PRD bar in two
important places:

1. **Indexer precision:** the PRD requires real tree-sitter parsing for the
   Greptile-tier wedge. The current `IndexingService` still describes and
   implements custom pattern matching/regex-style extraction. That is useful
   scaffolding, but it is not precise enough for stable AST ranges, repeatable
   symbol identity, import/call-site structure, or evidence validation.
2. **Finding verification:** the review loop produces findings and persists
   them after enum clamping, but it does not yet run a counter-evidence pass
   that tries to disprove each claim. This is why findings can be overstated:
   for example, "route has no auth" is materially different from "route has no
   handler-level auth, but `proxy.ts` partially gates it."

Docs updated:

- `prd.md` now makes real tree-sitter parsing non-negotiable for v1 and marks
  regex parsing as scaffolding only.
- `prd.md` now specifies a counter-evidence verification stage before findings
  are persisted or rendered as blockers.
- `roadmap.md` now includes explicit Track 1A tasks for tree-sitter replacement,
  stable AST identity, normalized edge kinds, import/export edges, and indexer
  fixture tests.
- `roadmap.md` now includes Track 1B tasks for `findingVerifier.ts`,
  counter-evidence retrieval, downgrade/discard rules, and wording guardrails.

Adopted verification rule:

> The review model produces candidate findings. BugHunter only publishes a
> final finding after local counter-evidence has been gathered and the finding
> has been classified as `confirmed`, `likely`, `partially_mitigated`,
> `needs_verification`, or `false_positive`.

Publishing guardrails:

- `false_positive` findings are discarded.
- `needs_verification` findings cannot be blockers.
- `partially_mitigated` findings must describe the mitigation and cannot use
  absolute wording.
- Blockers require a full entrypoint-to-impact chain plus counter-evidence
  checked.
- Findings with invalid file paths, nonexistent lines, or empty evidence chains
  are discarded before persistence.
