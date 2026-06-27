# Standards for Large PR Mode

The project has no `.agent-os/standards/index.yml`. The implicit standards being applied are conventions already established in the codebase that this spec must follow.

---

## Discriminated-union return shape (mirrors `assertIndexFresh`)

**Location:** `src/lib/indexFreshness.ts:25-85`, reused in `src/lib/reviewFreshness.ts`.

**Pattern:** Freshness/tier checks return a TypeScript discriminated union, not a boolean or thrown error:

```ts
type TierResult =
  | { ok: true; tier: "normal" }
  | { ok: true; tier: "grouped" }
  | { ok: true; tier: "oversized"; message: string };
```

**Why:** callers need to distinguish "small enough to scan normally" from "needs Large PR Mode" from "oversized but still worth a best-effort chunked review." The remediation differs (single `runPrScan` call vs chunked orchestration vs chunked orchestration with stronger warning copy). A boolean would collapse these.

**How to apply:** `assertTier(prManifest)` returns the union above. Never throw on classification errors — fail open with `{ ok: true, tier: "normal" }` so a classification bug does not block the scan. Do not refuse solely because of size in v1; `oversized` means "split recommended, chunk best-effort."

---

## Fail-open on infrastructure errors

**Location:** `src/lib/indexFreshness.ts:71-74`, `src/lib/reviewFreshness.ts`.

**Pattern:** When git/file/parse operations fail, the helper returns a sentinel that lets the scan proceed, rather than blocking. Better to run with degraded context than to block all work on a misconfigured environment.

**How to apply:** `buildDiffManifest` catches all errors and returns a manifest with `tier: "normal"` and an `error` field. `chunkDiff` returns a single chunk containing all files if the chunker fails. `aggregateResults` returns `reliability: "partial"` with the error recorded if dedup fails. Never throw across the orchestrator boundary.

---

## 500-line file rule

**Location:** CLAUDE.md (project root).

**Pattern:** Every file under 500 lines. Split big files into a directory of focused modules.

**How to apply:**

- `src/services/largePrReview/` directory with focused files:
  - `manifest.ts` (~120 lines) — diff manifest + file classification
  - `chunker.ts` (~180 lines) — priority-order chunking algorithm
  - `securitySensitive.ts` (~100 lines) — three-tier classification
  - `orchestrator.ts` (~200 lines) — `runLargePrReview` state machine
  - `aggregator.ts` (~150 lines) — dedup + reliability verdict
  - `types.ts` (~50 lines) — shared types
  - `index.ts` (~15 lines) — barrel
- Each file individually under cap. If `orchestrator.ts` grows past 400 during implementation, split state-machine steps into `orchestrator/` subdirectory.

---

## Lazy singletons via `getChatChain()` / `getEmbeddingChain()`

**Location:** `src/lib/llmClient.ts`, CLAUDE.md conventions entry.

**Pattern:** The OpenAI clients are lazy dual singletons with `globalThis` guards. Always go through `getChatChain()` / `getEmbeddingChain()` — never instantiate `OpenAI` at module load (breaks `next build`).

**How to apply:** Each chunk's `runPrScan` call uses the existing chat chain via `getChatChain()`. If the chain is empty (no providers configured), `runPrScan` already handles this (empty findings + null rating + actionable banner). The orchestrator does NOT need to re-implement provider fallback.

---

## Prisma `$transaction` avoidance on Supabase

**Location:** `src/lib/getRealLocalPrs.ts:158-162, 245-252` — explicit comments documenting the tradeoff.

**Pattern:** The Supabase transaction pooler (PgBouncer) caps interactive transactions at 5s. Chunk row writes (potentially 9+ inserts + updates per chunk) routinely exceed that. Sequential writes are the established pattern; the "partial state leaves zero rows" risk is repaired by the next refresh cycle or by idempotent retry.

**How to apply:** `ReviewChunk` lifecycle uses sequential writes:
1. `prisma.reviewChunk.createMany({ data: chunks })` — all chunk rows up front
2. Per chunk: `update({ where: { id }, data: { status: "running", startedAt } })` → run scan → `update({ data: { status, rating, completedAt } })`
3. Final: `prisma.reviewRun.update({ data: { reliability, chunksCompleted, ... } })`

Do NOT wrap any of this in `$transaction`.

---

## Per-PR locking via `acquireReviewLock`

**Location:** `src/lib/reviewLocks.ts`.

**Pattern:** The existing `acquireReviewLock(prId, force)` returns `{ status: "ok" } | { status: "busy", runId, startedAt, message }`. The same helper is used by `/api/prs/[prId]/scan`, `/api/hooks/prepush`, and `/api/prcheck/[prIdOrNumber]` so a UI scan and a CLI prcheck can't race.

**How to apply:** `runLargePrReview` acquires the same lock before chunking. This means:
- A PR in Large PR Mode can't be concurrently rescanned by any other entry point.
- The lock is held for the entire orchestrator run (potentially 30+ minutes for a 9-chunk PR).
- On any failure path (chunk failure, OOM, etc.), the orchestrator's catch block MUST call `endReview(prId)` to release the lock.

Do NOT introduce a chunk-level lock in v1. Per-PR locking is simpler and blocks the whole PR until done, which is the desired behavior.

---

## Backward-compat signature change

**Location:** `reviewService.ts` — `runPrScan` signature.

**Pattern:** When adding a parameter to an established function, make it optional (`?`) so existing callers keep working without changes.

**How to apply:**

```ts
// Before:
export async function runPrScan(prId: string, files: any[], reviewRunId: string): Promise<ScanResult>

// After:
export async function runPrScan(
  prId: string,
  files: any[],
  reviewRunId: string,
  reviewChunkId?: string,  // NEW — optional, for Large PR Mode attribution
): Promise<ScanResult>
```

When `reviewChunkId` is undefined (existing callers), behavior is identical. When provided, the chunk ID is written to `ReviewFinding.reviewChunkId` and `ReviewLog.reviewChunkId` for scoping.

---

## Chunk status state machine

**Pattern:** Chunk lifecycle is a strict state machine. Transitions:

```
pending → running → completed
                 → failed
                 → skipped
running → failed   (on retry-exhausted)
running → skipped  (on budget/concurrency guard)
failed → running   (on user-initiated retry — only state that goes backwards)
```

**How to apply:** Enforce in the orchestrator — never write `status: "completed"` from a chunk in `pending` state without an intermediate `running` update. The state machine is what makes retry/resume safe.

---

## Spec documentation convention

**Location:** `.agent-os/specs/` (10 existing specs after this one).

**Pattern:** Each spec is a folder `YYYY-MM-DD-HHMM-{slug}/` with exactly: `plan.md`, `shape.md`, `standards.md`, `references.md`, `tasks.md`. Plan files cite exact file:line references. Tasks files are phase-grouped `- [ ]` checkboxes, updated as work ships.

**How to apply:** This spec follows the convention exactly. Folder: `2026-06-27-large-pr-mode/`.
