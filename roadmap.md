# Roadmap: GrepLoop

**Status:** Living document. Updated whenever priorities shift.
**Pair with:** [`prd.md`](./prd.md) (what we're building) and [`CLAUDE.md`](./CLAUDE.md) (how the codebase is wired).

---

## Top-level priority: get PR inspection working

**The MVP is "I can scan a real PR and get real findings backed by codebase context."**

Everything else — multi-tenant auth, Docker packaging, observability, security hardening, backups — is downstream of that. The roadmap is sequenced to land MVP first, then layer production concerns on top once the core loop actually works.

This means:
- **Phase 0** is the minimum cleanup to start MVP work with a clean base
- **Phase 1 (MVP)** is the review engine + indexing end-to-end — this gets the bulk of the time
- **Phases 2–4** are post-MVP and only start after the MVP loop is proven

---

## Where we are now (June 2026)

GrepLoop is a single-framework Next.js 16 app talking to Supabase Postgres via Prisma 7.8. Express and Firebase are gone. All 18 API endpoints are Route Handlers. The dashboard boots, talks to real Supabase, and can run a **fake** review against a local git repo — `reviewService.ts` returns hardcoded sample findings.

**Done in the current cycle:**
- Consolidated PRD-1 + PRD-2 into one self-hosted-multi-tenant spec (`prd.md` Draft v3)
- Removed Express + Firebase; migrated all endpoints to Next Route Handlers
- Wired the in-app DB config tab to real Postgres/Supabase connections (with the pg 8.21 SSL workaround)
- Extracted `DashboardSidebar`, `DbConfigView`, `PrsView`, `AddRepoModal` out of `App.tsx` (1,642 → 774 lines)
- Added CI (lint + test + build on PR)
- Added Vitest smoke tests for `dbConfig.ts` and `types.ts`
- Deleted the prompt-injection `AGENTS.md`, replaced with a clean `CLAUDE.md`
- Scrubbed leaked Supabase password out of `.env.example`

**Carryover (small items, fold into Phase 0):**
- Extract `useDashboardData` hook — `App.tsx` is still 774 lines, target <500
- Rebrand "Woodhill" strings (`src/App.tsx` footer, `reviewService.ts` sample findings)
- Rotate Supabase DB password (leaked in git history at `9ac1490` — **user action, dashboard**)
- Delete `FIREBASE_SERVICE_ACCOUNT_GREPLOOP_956F8` GitHub repo secret (**user action, repo settings**)

---

## Phase 0 — Clear the deck (DONE, June 2026)

**Goal:** Zero loose ends blocking MVP work. Codebase is in a state where a Phase 1 branch starts from a clean base.

### Work items
- [x] Extract `useDashboardData` hook from `App.tsx` to get it under 500 lines — dropped 774 → 330 lines (`58cb1d2`)
- [x] Rebrand "Woodhill" → "GrepLoop" in `src/App.tsx` footer and `reviewService.ts` sample findings (`f529456`)
- [x] Quick `README.md` rewrite — what GrepLoop is, how to run it, link to `prd.md` and `CLAUDE.md` (`b5b68ff`)
- [ ] ~~Delete the fake sample findings from `reviewService.ts` stub~~ — deferred; the stub stays as a placeholder until Phase 1 Track 1B replaces it with the real engine

### Definition of Done
- [x] `App.tsx` < 500 lines (now 330)
- [x] No "Woodhill" string anywhere in `src/`
- [x] `npm run lint && npm test` clean
- [ ] User actions still pending: rotate Supabase DB password (leaked in git history at `9ac1490`); delete `FIREBASE_SERVICE_ACCOUNT_GREPLOOP_956F8` GitHub repo secret

### Why this comes first
A 774-line `App.tsx` makes every Phase 1 edit painful. The Woodhill strings will surface in screenshots during MVP testing. Both are 30-minute jobs — clear them now.

---

## Phase 1 — MVP: Real PR inspection end-to-end (the main event)

**Goal:** A user links a local repo, picks a PR, hits Scan, and gets back real findings — each finding pointing at actual code, informed by the whole codebase (not just the diff). The fake `reviewService.ts` is gone.

This is the longest phase. It has three sub-tracks that come together at the end:

### Current gap audit (2026-06-24)

The repo has the right broad architecture, but the next implementation pass should treat these as adoption blockers for the PRD:

- Current indexing is pattern/regex based, not tree-sitter based.
- `getCallers` and indexed edge rows disagree on edge kind casing (`CALLS` vs `call`).
- `searchCodebase` is substring lookup, while the PRD defines it as semantic search over embedded summaries.
- Findings are persisted without a verifier that validates evidence lines or retrieves counter-evidence.
- `ReviewPass`/ensemble schema is still absent; keep single-model as v1 behavior, but leave the schema migration path clean.

### Track 1A: Codebase indexing (the Greptile-tier wedge)

This is what separates real review quality from diff-only reviewers per PRD Section 1.

- [x] **Replace regex/pattern indexing with real tree-sitter** — TypeScript/JavaScript first (eat our own dog food — GrepLoop itself is TS). Grammar: `tree-sitter-typescript`. Regex extraction is scaffolding only and does not satisfy the PRD. **Done 2026-06-24** — see `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/`.
- [x] **Stable AST node identity** — symbol IDs derived from repo, file, node kind, name, and line range so re-indexing is repeatable enough for evidence chains.
- [ ] **Symbol extraction** — functions, classes, methods, exports. Schema: `Symbol` table with `{ repoId, filePath, name, kind, startLine, endLine, signature }`
- [ ] **Call graph edges** — `caller → callee` per symbol. Schema: `Edge` table with `{ repoId, fromId, toId, toRaw, kind, filePath, line }`. Normalize edge kinds (`CALLS` vs `call`) so review tools and index rows agree.
- [ ] **Import/export graph** — extract `IMPORTS`, `DEFINES`, `EXTENDS`, and unresolved edges where tree-sitter can identify structure but not targets.
- [ ] **Per-symbol LLM summaries** — one short paragraph per function (e.g. "Validates user session and returns the org membership"). Batched, cheap model, generated during indexing.
- [ ] **pgvector enabled** on Supabase (it's available — just needs turning on)
- [ ] **Embeddings** for every symbol + every docstring/comment block. Default to a local embedding model (`nomic-embed-text` via Ollama) to keep cost at zero; cloud embedding (OpenAI-compatible, e.g. `text-embedding-3-small` via OpenRouter) opt-in.
- [ ] **Incremental indexing** — file watcher on the repo's git HEAD. Re-index only changed files. Full re-index only on first link or manual trigger.
- [ ] **Indexing status UI** — the dashboard already has a polling UI; make it show real progress (files indexed, symbols extracted, embeddings generated)
- [ ] **Indexer validation tests** — fixture files for TS route handlers/hooks/classes; assert symbol ranges, call edges, imports, and unchanged-file skip behavior.

### Track 1B: Real review engine

Replace the fake `reviewService.ts` with actual LLM-driven review.

- [ ] **Pluggable LLM router** — OpenAI-compatible endpoint (OpenRouter by default, Ollama/LM Studio for local) as the only cloud path, "no LLM" rule-only fallback so the app works without an API key. Model picker in the LLM Settings tab lets you switch between any provider/model at runtime.
- [ ] **Diff parsing** — current code reads git diff; verify it handles added/removed/modified hunks correctly
- [ ] **Context retrieval per diff hunk** — for each hunk, pull:
  - The k nearest symbols by embedding similarity (pgvector)
  - All direct callers and callees of any symbol in the diff (call graph edges)
  - The LLM summary of each retrieved symbol
- [ ] **Per-hunk LLM call** — diff hunk + retrieved context → structured findings array
- [ ] **Evidence chain shape** — every finding: `{ finding, severity, category, file, lineRange, why, relatedSymbols: [{name, file, line}] }`. Every finding's file/line references are **validated to exist** before display, and diff-origin findings validate against the diff hunk when applicable.
- [ ] **Counter-evidence retrieval** — before persistence, gather local code that could disprove each candidate finding: proxy/middleware, auth helpers, route matchers, Prisma schema, caller context, locks, transactions, provider allowlists, env defaults, and framework docs when needed.
- [ ] **Finding verifier** — add `src/services/findingVerifier.ts` to classify candidates as `confirmed`, `likely`, `partially_mitigated`, `needs_verification`, or `false_positive`; discard false positives, downgrade partials, and prevent unverified blockers.
- [ ] **Precise wording guardrails** — final findings must mention mitigations found by the verifier; no absolute claims like "NO auth" when a proxy/session/API-key gate partially applies.
- [ ] **Review categories** from PRD Section 14: OWASP top 10, WCAG, Core Web Vitals, type safety, plus standard bug/smell checks
- [ ] **Persist findings** to `ReviewFinding` table (schema already exists) with full evidence chain JSON
- [ ] **Streaming UI** — findings appear as they're generated, not after a 30-second wait
- [ ] **Token / cost accounting** — visible per review (so you can see "this PR cost $0.14")

### Track 1C: PR inspection plumbing

The endpoints already exist. Verify and polish the end-to-end flow:

- [ ] `POST /api/repos/:id/index` triggers Track 1A (currently exists; ensure it kicks the real indexer, not a stub)
- [ ] `POST /api/prs/:prId/scan` runs Track 1B against the linked repo's indexed data
- [ ] `GET /api/prs/:prId/findings` returns persisted findings with evidence chains
- [ ] `GET /api/prs/:prId/files` returns the PR's changed files (already exists — verify diff shape)
- [ ] **End-to-end manual smoke test**: link GrepLoop's own repo, index it, scan a real PR, verify findings reference real code lines

### Definition of Done (the MVP gate)
- A scan against a real PR produces findings that cite actual line ranges in the codebase
- Findings include context from outside the diff (proves indexing works)
- Every blocker has a full entrypoint-to-impact evidence chain and a counter-evidence section
- False positives, unverifiable claims, and findings with invalid lines are discarded or downgraded before persistence
- Running the same scan twice produces ~the same output (stability)
- Cost per review is visible in the UI
- The fake sample findings in `reviewService.ts` are deleted
- A second person watching the dashboard can see findings stream in during a scan

### Risks (the things most likely to slow Phase 1)
1. **Hallucinated evidence** — LLM cites line 472 of a 200-line file. Mitigation: hard-validate every line range before display.
2. **Overstated findings** — model sees a risky local pattern but misses surrounding mitigations. Mitigation: mandatory counter-evidence retrieval and verifier downgrade rules.
3. **Embedding cost** — 100k symbols × cloud embedding API = real money. Default to local embeddings via Ollama; cloud opt-in.
4. **tree-sitter grammar maintenance** — start with TS only; add languages one at a time after MVP.
5. **pgvector index choice** — HNSW vs IVFFlat. Default HNSW for recall; revisit at scale.
6. **Indexing latency** — first-time indexing of a 50k-line repo must be tolerable. Aim for <5 minutes; incremental <30s.
7. **LLM call cost runaway** — without per-org quotas (post-MVP) a tight inner loop could rack up a big bill. Hard-cap reviews-per-day per repo as a stopgap.

### Out of scope for MVP (deferred to later phases)
- Multi-user auth (you can test solo)
- Docker packaging (run locally with `npm run dev`)
- Observability tooling (`console.log` is fine for MVP testing)
- Security hardening (local-only deployment)
- Migration history (`prisma db push` is fine while solo)
- Backup procedures (your Supabase project has its own backups)

---

## Phase 2 — Multi-tenant auth (post-MVP)

**Goal:** A user can sign up, sign in, be a member of an organization, and only see repos their role grants. PRD Section 5 implemented end-to-end.

**Don't start until the MVP loop is proven.** Retrofitting auth onto working Route Handlers is mechanical; building auth before review works is premature.

### Work items
- [ ] Install and configure Better Auth 1.6 with the organizations plugin
- [ ] Prisma schema: `User`, `Organization`, `OrganizationMember`, `RepositoryMember` (PRD Section 5.1 — schema supports multi-org from day one)
- [ ] Better Auth schema migration (`user`, `session`, `account`, `verification`, `organization`, `member`)
- [ ] Sign-up / sign-in / sign-out UI
- [ ] Organization switcher in `DashboardSidebar`
- [ ] Role enforcement: owner / member / viewer per org; same trio per repo
- [ ] **Row-level scoping in every Route Handler** — every `prisma.repo.findMany()` becomes `prisma.repo.findMany({ where: { orgId, id: { in: visibleRepoIds } } })`
- [ ] Invite flow: org owner types an email, recipient gets a magic link
- [ ] Audit log table (write side; viewer comes in Phase 3)

### Risks
- **Forgetting a Route Handler during scoping** — CI test should hit each endpoint as a no-access user and assert 404
- **Better Auth schema collision** with existing tables — test against a throwaway Supabase branch first

---

## Phase 3 — Production hardening (when someone else installs it)

**Goal:** A second person — not the author — can clone, configure, and run GrepLoop in their own infrastructure without calling the author.

### 3a. Deployment packaging
- [ ] `Dockerfile` (multi-stage, Next.js standalone output, <300MB final image)
- [ ] `docker-compose.yml` with GrepLoop + Postgres + (optional) Ollama
- [ ] `GET /api/health` (DB reachable, LLM configured, indexer idle)
- [ ] Migration runner as container entrypoint (`prisma migrate deploy` before Next boots)
- [ ] Every environment variable documented in `README.md`

### 3b. Observability
- [ ] Structured logging (pino) — replace `console.log` across Route Handlers
- [ ] Request IDs propagated end-to-end
- [ ] Error tracking (GlitchTip for self-hosted Sentry parity) with source maps
- [ ] Metrics endpoint: reviews/run, avg latency, LLM spend, index freshness

### 3c. Security hardening
- [ ] Rate limit: 5 auth attempts/min/IP, 10 scan requests/hour/org
- [ ] CSRF protection on cookie-auth form posts
- [ ] Verify `Secure`/`HttpOnly`/`SameSite=Lax` on auth cookies
- [ ] Audit log viewer in the admin UI
- [ ] `npm audit` clean, Dependabot enabled

### 3d. Migration strategy
- [ ] First real Prisma migration (`prisma migrate dev` to baseline)
- [ ] Test migration against a fresh empty database
- [ ] Documented upgrade path: pull image → `prisma migrate deploy` → restart

### 3e. Backup and DR
- [ ] Documented `pg_dump` / `pg_restore` procedure
- [ ] Supabase PITR pointer in docs (for self-hosters not on Supabase)
- [ ] Test restore from backup into a fresh database at least once

### Definition of Done
- A second person (not the author) follows `README.md` and has GrepLoop running within an hour
- Structured logs are queryable
- Auth brute-force is throttled
- `pg_dump` restore tested against a fresh Postgres

---

## Cross-cutting concerns (applied throughout, not phases)

### Testing
- **Current:** 22 tests against `src/lib/*`
- **Phase 1 target:** Review engine fixture tests — diff in, expected findings out (mock LLM)
- **Phase 1 target:** Indexing integration test — index a small fixture repo, assert graph shape
- **Phase 2 target:** Route handler tests with auth scoping (no-access user → 404)
- **Never:** E2E tests hitting a real LLM. Mock in CI, real LLM in manual smoke tests.

### Documentation
- `README.md` — getting started (Phase 0)
- `docs/self-hosting.md` — Phase 3 deliverable
- `docs/api.md` — auto-generated from Route Handler types
- `CLAUDE.md` — kept current
- Inline comments — only when the *why* is non-obvious

### Accessibility
GrepLoop checks other people's code for WCAG (PRD Section 14). Eat our own dog food.
- [ ] Phase 1: keyboard-navigable sidebar, focus traps in modals
- [ ] Phase 1: aria-live regions for streaming findings
- [ ] Phase 3: axe-core in CI, zero critical violations

### Performance
- 2s dashboard polling cadence is current (acceptable)
- Watch for N+1 in Phase 2 auth scoping
- Vector search latency budget: <100ms at 100k symbols (Phase 1 DoD)

---

## Explicitly deferred (per PRD Non-Goals — do **not** pull forward)

- Posting review comments back to GitHub/GitLab/Bitbucket PRs
- IDE-embedded inline annotations (VS Code extension)
- Review of non-text/binary diffs
- Cross-organization repository sharing (a repo belongs to exactly one org for MVP)
- Public SaaS hosted by us
- Billing / paid tiers — deployment model is "customer runs it themselves"

---

## Decision points (need user input, not yet resolved)

1. **Default LLM backend for MVP?** ~~Cloud Gemini (zero setup, real money per scan) vs local Ollama (one-time multi-GB download, then free).~~ **Resolved:** OpenAI-compatible endpoints via OpenRouter as the only cloud path — one SDK, hundreds of models (Gemini, Claude, Qwen, etc.) selectable at runtime. Ollama/LM Studio work as just another OpenAI-compatible endpoint for local use.
2. **Default embedding model for MVP?** ~~Local `nomic-embed-text` via Ollama (free, requires Ollama installed) vs Gemini embedding API.~~ **Resolved:** User picks from the same OpenRouter/compatible catalog in the LLM Settings tab. `findSimilar` gracefully degrades if no embedding model is configured.
3. **Initial language support?** TypeScript only (eat our own dog food, fastest to MVP) vs TS + Python (covers more users). Recommend **TS only for MVP**, add languages one at a time.
4. **CI environment coverage?** Add a Postgres service container for integration tests, or keep CI unit-only and run integration tests manually? Recommend **unit-only for MVP**; revisit in Phase 3.

---

## Recommended next move

**Finish Phase 0 (1–2 days), then start Phase 1 Track 1A (indexing).**

Indexing is on the critical path — the review engine (Track 1B) is blocked without indexed data to retrieve from. Start the indexer first; while it's cooking, wire the LLM router and prompt chain in parallel. Track 1C (endpoint polish) is the small piece that brings it together at the end.

Realistic Phase 1 timeline: 2–4 weeks solo. The first end-to-end scan (even ugly) is the milestone; everything after that is quality improvements.

---

## Changelog

- **2026-06-20** — Rewrote with MVP-first priority. PR inspection (indexing + review engine end-to-end) is now Phase 1 and gets the bulk of time. Auth, deployment, observability, and security hardening all defer to post-MVP phases. Original 5 in-conversation directions plus 8 additional aspects (deployment packaging, observability, security hardening, migration strategy, backup/DR, testing targets, documentation, accessibility) retained but reordered around the MVP gate.
