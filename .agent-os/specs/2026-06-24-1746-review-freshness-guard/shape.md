# Review Freshness Guard + v1 Finding Verifier — Shaping Notes

## Scope

Two layered fixes for the "stale review rendered as current" bug observed on 2026-06-24:

1. **Freshness invariant** — every scan records a `ReviewRun` keyed by `(prId, commitHash, diffHash, reviewConfigHash)`. Re-scans with unchanged inputs short-circuit (no LLM cost). The findings route returns only the latest completed run matching current state. Older runs are preserved as history, never shown as current.

2. **v1 Finding verifier** — post-candidate, pre-persistence validation. Line/file existence checks for all findings. Targeted counter-evidence retrieval for 4 high-stakes finding categories: auth, data isolation, webhook/network, concurrency. Rejected findings stay in DB (audit trail) but the route filter hides them.

## Decisions

- **Full `ReviewRun` model** (not minimal fields on PullRequest). Aligns with PRD §14.7 ReviewPass hook "should land before Phase 1.5." Sets up the multi-model ensemble work without requiring it now. Preserves audit trail of prior runs.
- **`diffHash` is the load-bearing invariant, not `commitHash`.** Commit hashes change on every rebase/merge even when the diff is identical. Diff content hash is stable across cosmetic history reshuffles. Store both, key the freshness check on diffHash + reviewConfigHash.
- **Short-circuit when `(prId, commitHash, diffHash, reviewConfigHash)` all match a completed run.** `reviewConfigHash` captures model + system prompt — swapping models invalidates the cache automatically. `force=true` query param bypasses for manual re-scans.
- **Verifier scope v1 = line/file validation + counter-evidence for 4 categories.** Full PRD §14.6 5-class taxonomy (`confirmed`/`likely`/`partially_mitigated`/`needs_verification`/`false_positive`) deferred to a follow-on spec. v1 uses simpler `verified`/`downgraded`/`rejected`/`unverified`.
- **Verifier never throws.** On LLM failure, parse failure, or any exception, finding is marked `unverified` and persisted as-is. Verifier is defense-in-depth, not a gate.
- **Legacy findings preserved.** Existing `ReviewFinding` rows get a synthetic `legacy` ReviewRun on migration. They naturally fall out of "current" once a fresh scan produces real hashes.
- **Rejected findings stay in DB.** Audit trail is valuable — "previous review said X, we changed Y, verifier now says Z." Route filter is what hides them from the UI, not deletion.

## Context

- **Visuals:** None. UI changes are additive badges + collapsible details — no mockups needed.
- **References:** See `references.md`. Primary pattern source is `src/lib/indexFreshness.ts:25-85` (`assertIndexFresh` discriminated union).
- **Product alignment:** Directly addresses PRD §14.6 (verifier gap) and §14.7 (ReviewPass schema hook). Roadmap L77-78 echoes both.

## Triggering incident

On 2026-06-24, an AI scan of `feature/bug-demo` returned 4/10 with 8 findings. 3 of 4 BLOCKERS cited code already fixed in commit `2e4113e` days earlier (`authenticateIfExternal` renamed, `gitRemote.buildSshEnv` switched to `mkdtempSync`, `findPrByIdOrNumber` scoped to `repoId`). The scanner was reporting against stale state with no UI signal that the findings didn't match current code. This spec prevents that class of bug at two layers: freshness (right diff) + verifier (correct about that diff).

## Standards Applied

- **discriminated-union return shape** — mirror `assertIndexFresh` from `src/lib/indexFreshness.ts:25-27`. Fail-open on git/parser errors (never block scans on hash computation failures).
- **500-line file rule** — `reviewFreshness.ts` and `findingVerifier.ts` each kept under 500 lines, split into focused helpers if needed (per CLAUDE.md).
- **lazy singletons via `getChatChain()`** — verifier reuses existing chat chain; never instantiates OpenAI clients directly (mirrors `llmClient.ts` pattern).
- **Prisma `$transaction` avoidance on Supabase** — PgBouncer caps interactive transactions at 5s; the spec uses sequential writes (mirrors `getRealLocalPrs.ts:158-162` pattern).
