# Standards for Review Freshness Guard + v1 Finding Verifier

The project has no `.agent-os/standards/index.yml`. The implicit standards being applied are documented below — these are conventions already established in the codebase that this spec must follow.

---

## Discriminated-union return shape (mirrors `assertIndexFresh`)

**Location:** `src/lib/indexFreshness.ts:25-85`

**Pattern:** Freshness checks return a TypeScript discriminated union, not a boolean or thrown error:

```ts
type Freshness =
  | { ok: true }
  | { ok: false; kind: "INDEX_REQUIRED" | "STALE_INDEX"; message: string };
```

**Why:** callers need to distinguish "no index exists" from "index exists but stale" — the remediation differs (409 INDEX_REQUIRED vs trigger incremental reindex silently). A boolean would collapse these.

**How to apply:** `assertReviewFreshness` returns the same shape with kinds `NO_RUN` and `STALE_RUN`. Never throw on git/parser errors — fail open with `{ ok: false, kind: "NO_RUN", message: "..." }` so the scan proceeds.

---

## Fail-open on infrastructure errors

**Location:** `src/lib/indexFreshness.ts:71-74`

**Pattern:** When `currentHeadCommit` fails (not a git repo, git binary missing, timeout), `assertIndexFresh` returns `{ ok: true }` — the scan proceeds. Better to run a scan with stale context than to block all scans when git is misconfigured.

**How to apply:** `computeDiffHash` and `computeReviewConfigHash` must never throw on malformed input — return a sentinel hash (e.g., empty string) and let `assertReviewFreshness` treat that as "can't verify, run the scan."

---

## 500-line file rule

**Location:** CLAUDE.md (project root)

**Pattern:** Every file under 500 lines. Split big files into a directory of focused modules (e.g., `users/manage/personalDetails.tsx`).

**How to apply:**
- `src/lib/reviewFreshness.ts` — estimate ~180 lines (under cap).
- `src/services/findingVerifier.ts` — estimate ~280 lines (under cap, but close). If it grows past 400 during implementation, split into `findingVerifier/` directory with `lineValidator.ts`, `counterEvidence.ts`, `llmVerdict.ts`.
- `reviewService.ts` — already large; this spec modifies in place but doesn't extend it significantly.

---

## Lazy singletons via `getChatChain()` / `getEmbeddingChain()`

**Location:** `src/lib/llmClient.ts`, CLAUDE.md conventions entry

**Pattern:** The OpenAI clients are lazy dual singletons with `globalThis` guards. Always go through `getChatChain()` / `getEmbeddingChain()` — never instantiate `OpenAI` at module load (breaks `next build`).

**How to apply:** The verifier uses `getChatChain()[0]` for LLM-assisted verdicts. If the chain is empty (no providers configured), the verifier marks all findings `unverified` and persists them — never throws.

---

## Prisma `$transaction` avoidance on Supabase

**Location:** `src/lib/getRealLocalPrs.ts:158-162, 245-252` — explicit comments documenting the tradeoff.

**Pattern:** The Supabase transaction pooler (PgBouncer) caps interactive transactions at 5s. Payloads carrying full file contents/diffs routinely exceed that. Sequential writes (delete + createMany) are the established pattern; the "partial state leaves zero rows" risk is repaired by the next refresh cycle.

**How to apply:** The new ReviewRun lifecycle uses sequential writes — `reviewFinding.deleteMany` then `reviewFinding.createMany` then `reviewRun.update`. Do NOT wrap in `$transaction`.

---

## Backward-compat shim re-exports

**Location:** `src/services/indexingService.ts` (13-line shim), `src/services/indexing/index.ts` barrel.

**Pattern:** When refactoring breaks import paths, leave a one-line re-export at the old location so callers don't need to change. New code imports from the new location.

**How to apply:** If `runPrScan` moves out of `reviewService.ts` during implementation (not planned but possible if the file grows too large), leave a re-export at the original path.

---

## Spec documentation convention

**Location:** `.agent-os/specs/` (6 existing specs).

**Pattern:** Each spec is a folder `YYYY-MM-DD-HHMM-{slug}/` with exactly: `plan.md`, `shape.md`, `standards.md`, `references.md`, `tasks.md`. Plan files cite exact file:line references back to `prd.md` and `roadmap.md`. Tasks files are phase-grouped `- [ ]` checkboxes, updated as work ships.

**How to apply:** This spec follows the convention exactly. Folder: `2026-06-24-1746-review-freshness-guard/`.
