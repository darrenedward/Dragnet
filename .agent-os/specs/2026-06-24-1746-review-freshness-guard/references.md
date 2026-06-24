# References for Review Freshness Guard + v1 Finding Verifier

## Pattern Implementations

### `assertIndexFresh` — discriminated-union freshness pattern

- **Location:** `src/lib/indexFreshness.ts:25-85`
- **Relevance:** This is the canonical pattern for `assertReviewFreshness` to mirror. Same file also contains `currentHeadCommit(repoPath)` — the git helper that returns the full HEAD SHA.
- **Key patterns to borrow:**
  - Discriminated union return type: `{ ok: true } | { ok: false; kind, message }`
  - Fail-open on git errors (lines 71-74): if `currentHeadCommit` returns null, return `{ ok: true }` rather than blocking
  - `execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeout: 5000 })` — no shell, no injection risk

### `getRealLocalPrs.ts` — diff source + transaction-avoidance pattern

- **Location:** `src/lib/getRealLocalPrs.ts:44-52, 243-271`
- **Relevance:** `refreshPrFiles` is the source of the `RepoFile[]` that `computeDiffHash` hashes. The file also documents the PgBouncer transaction-cap pattern that the new persistence flow must follow.
- **Key patterns to borrow:**
  - `RepoFile` interface (lines 44-52): `{ filename, status, additions, deletions, originalContent, modifiedContent, diff }`
  - Comment block at lines 158-162: rationale for NOT wrapping delete+createMany in a transaction
  - Same pattern repeated at lines 245-252 in `refreshPrFiles`

### `indexOrchestrator.ts` — stable hash ID pattern

- **Location:** `src/services/indexing/indexOrchestrator.ts:433-441`
- **Relevance:** `makeSymbolId` shows the established pattern for deterministic hashing in this codebase — `md5(seed).hex().slice(0, 12)`. The new `computeDiffHash` / `computeReviewConfigHash` follow the same approach but with sha256 and 16-char output for stronger collision resistance.
- **Key patterns to borrow:**
  - `crypto.createHash("md5").update(seed).digest("hex")` — inline, no wrapper helper
  - Determinism comment: "same input → same id" — same property needed for diff hash

### `reviewService.ts:534-579` — finding persistence block

- **Location:** `reviewService.ts:534-579`
- **Relevance:** This is the exact block that needs modification. Currently does `deleteMany` → `createMany` → `pullRequest.updateMany` → `reviewHistory.create` → `repository.update` (reviewsCount++). New flow inserts verifier call between candidate generation and the persistence block, and adds `reviewRunId` + `verificationStatus` to each row.
- **Key patterns to borrow:**
  - `randomUUID()` for finding IDs
  - `timestamp: new Date().toISOString()` as string (not DateTime)
  - `skipDuplicates: true` on createMany

### Prior freshness spec — format template

- **Location:** `.agent-os/specs/2026-06-23-2031-index-freshness-gates/plan.md`
- **Relevance:** Closest precedent — an index-level freshness gate that landed 2026-06-23. Same structure (Context → Phases → Verification → Critical files). Confirms the spec format and shows how a similar discriminated-union freshness check was documented.
- **Key patterns to borrow:**
  - Phase structure with explicit Files + Pattern + Verify per phase
  - Citations back to `prd.md` and `roadmap.md` line numbers
  - Migration handling notes (synthesizing legacy rows)

### Multi-provider fallback spec — failure-handling pattern

- **Location:** `.agent-os/specs/2026-06-23-1919-multi-provider-fallback/plan.md`
- **Relevance:** Shows how the codebase handles "all providers failed" gracefully — empty results + actionable banner, never templated/hallucinated output. The verifier follows the same philosophy: on LLM failure, mark `unverified` and persist; never block.
- **Key patterns to borrow:**
  - Circuit-breaker concept (could apply to verifier if LLM calls keep failing)
  - "Actionable banner" UI pattern for surfacing partial failures

## PRD references

- **`prd.md:340`** — §14.6: "Add the verifier before rendering blockers." Direct citation for Task 5.
- **`prd.md:341`** — §14.7: "`ReviewPass` and ensemble reconciliation are not in the current schema yet; single-model review remains the v1 default, but the schema hook should land before Phase 1.5." Direct citation for Task 2.
- **`prd.md:110, 125, 439, 458, 464`** — ReviewPass mentions throughout PRD. Confirms the model name and its role.
- **`roadmap.md:77-78`** — Gap audit echoing both findings.
- **`roadmap.md:109-110, 138`** — Verifier + counter-evidence retrieval tasks.

## Triggering incident

- **Commit `2e4113e`** — "close 4 security gaps found in AI code review" — the fixes that the stale scan reported against. Documents the exact bugs that would have been caught by this spec's verifier.
- **Commit `fee3a6e`** — spec for the AI-review security fixes — companion spec documenting what was fixed in `2e4113e`.
