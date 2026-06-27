# Plan — Large PR Mode

## Context

**The bug this fixes.** On 2026-06-27, a `/gloop fix 1 --auto` re-review of `feature/bug-demo` (commit `130f5bf`) ran for ~11 minutes then **failed** — Minimax-M3 exhausted all 16 agentic-loop iterations without emitting a `submitReview` tool call, and the Z.ai Flash fallback also failed (`ReviewRun run-b35b6509-3474-4250-87b7-32ca21b0cf17`, `status: failed`, `rating: null`). The diff was 21,053 lines across 178 files. The prior cached 7/10 run had squeaked through on a smaller diff at `3e0c5ea`; the new commit pushed it past the model's effective context budget.

**Root cause.** `runPrScan` (reviewService.ts:326) treats every PR as a single agentic pass. There is no concept of "this PR is too large for one pass" — the model receives the entire diff and either succeeds or fails the whole run. No commercial or self-hosted code-review tool can reason over a 21k-line diff; the failure mode is silent (empty findings + null rating) rather than honest ("diff too large, splitting into chunks").

**Outcome.** After this spec ships:
- All PR-bearing surfaces expose a `sizeProfile` first (small / medium / large / oversized) so the user sees the risk before any scan behavior changes.
- PRs above the normal threshold auto-route to Large PR Mode.
- The diff is split into directory-tiered chunks (monorepo package → file type → 600-line cap), each scanned independently by the existing `runPrScan` primitive.
- Each `ReviewChunk` row has its own lifecycle (`pending | running | completed | failed | skipped`), enabling idempotent retry without re-running the whole scan.
- The final `ReviewRun` carries an explicit `reliability` verdict: `complete | partial | incomplete_security_review`. Partial reviews are never presented as complete.
- Security-sensitive chunks (matched by global default globs, keyword fallback, or repo-configured additions) that fail → rating `null`, no false green.
- Oversized PRs are not silently blocked in v1. They are chunked best-effort with an explicit "split recommended" warning and may still end `partial` / `incomplete_security_review`.
- UI shows a "Large PR Mode: N chunks" banner with per-chunk progress and a failed-chunk retry button.

**Decisions locked with user (2026-06-27):**
- **Orchestration around `runPrScan`, not inside it.** `runLargePrReview(reviewRunId)` is the new entry point; `runPrScan` becomes a chunk-level primitive with optional `reviewChunkId` parameter (backward compatible).
- **Chunking is a priority order:** (1) monorepo package boundary → (2) file type within package → (3) 600-line size cap with recursive split. Deterministic for v1.
- **Sequential chunk execution for v1** (concurrency=1). Parallel is v1.1.
- **Per-PR locking** via existing `acquireReviewLock` — no new chunk-level lock.
- **Three-tier security-sensitive classification:** global defaults + keyword fallback + repo-configured `Repository.securitySensitivePaths`.
- **`incomplete_security_review` reliability state** replaces the earlier vague `unreliable` — tells the user exactly what went wrong.
- **Auto-route to Large PR Mode**, no opt-in. Banner discloses cross-chunk bug risk.
- **PR Size Profile ships first as a standalone prerequisite.** It is a warning label, not a gate. Large PR Mode consumes it later for routing and UI copy.
- **No cost estimation in v1** — just chunk count. v1.5 adds $.

**Out of scope (follow-on specs):**
- Parallel chunk execution (v1.1, configurable up to 3).
- Call-graph-aware chunking via `Symbol`/`Edge` tables (v2, the differentiator).
- Cross-chunk bug merge pass (v1.5).
- Hard refusal for oversized PRs (future optional policy). v1 warns + best-effort chunks.
- Configurable thresholds (hardcoded for v1).
- Security-sensitive path config UI (v1.1 — DB/API editable in v1).
- Repo rename to Prism (deferred — separate decision).

---

## Task 1: Save Spec Documentation

Create `.agent-os/specs/2026-06-27-large-pr-mode/` with five files matching the convention (see `.agent-os/specs/2026-06-24-1746-review-freshness-guard/`):

- **plan.md** — this plan, verbatim
- **shape.md** — scope, decisions, context (per shape-spec template)
- **standards.md** — implicit standards being applied (discriminated-union return shape, 500-line rule, fail-open on infrastructure errors, sequential Prisma writes, per-PR locking via `acquireReviewLock`, chunk status state machine)
- **references.md** — pointers to `reviewLocks.ts` (locking), `findingVerifier.ts` (post-processing pattern), `reviewFreshness.ts` (lifecycle helpers), `getRealLocalPrs.ts` (diff source), `indexFreshness.ts` (discriminated-union pattern)
- **tasks.md** — phase-grouped `- [ ]` checkboxes, updated as work ships

Also update `roadmap.md` with a Large PR Mode entry under the review-pipeline section.

---

## Task 1.5: Prerequisite — PR Size Profile (standalone quick win)

Before Large PR Mode changes scan behavior, ship `.agent-os/specs/2026-06-27-pr-size-profile/` as a smaller standalone enhancement.

**Why it is separate.** Size Profile is useful even without chunking: it warns users that review quality may degrade for large PRs, and it sets expectations before Large PR Mode starts splitting work. It should not block scans or force a workflow change.

**Profile tiers** use code-line counts, not raw diff lines. Exclude docs/specs/README, lockfiles, generated files, vendored files, and assets using the same classifier Large PR Mode will later reuse.

| Tier | Trigger | UX copy |
| --- | --- | --- |
| `small` | `<500` code lines and `<15` commits | `420 code lines · 3 commits` |
| `medium` | `500–1500` code lines or `15–40` commits | `850 code lines · 12 commits — smaller PRs improve scan quality` |
| `large` | `1500–3000` code lines or `40–100` commits | `1900 code lines · 25 commits — scan quality may degrade` |
| `oversized` | `>3000` code lines or `>100` commits | `4500 code lines · 80 commits — split recommended` |

**Surfaces:**
- PR list responses and sidebar PR rows.
- PR check/status responses and `/gloop` output.
- Fresh scan responses.
- `/api/prs/[prId]/findings` response and ReviewCard chip.
- Pre-push hook output before the review starts.

**Implementation note:** build this around a shared `sizeProfile` utility and file classifier. Large PR Mode's manifest should import/reuse it rather than inventing a second classifier.

**Verify:** a dependency-only `package-lock.json` diff does not show as large; a 2000-code-line PR shows `large`; a 4500-code-line PR shows `oversized` but is not blocked solely by size.

---

## Task 2: Prerequisites — vector dimension audit + `runPrScan` signature

Two unrelated-but-blocking cleanups land first.

### 2a: `vector(1536)` → `vector(1024)` audit

**Files:** `prd.md`, `roadmap.md`, `CLAUDE.md`, any code comments.

Search the whole repo for `1536` and reconcile to the current `vector(1024)` schema (`prisma/schema.prisma:185` confirms `Unsupported("vector(1024)")`). This is a doc-only fix — schema is already correct. Ship as a separate one-line commit before any Large PR Mode work, because Task 7's security-sensitive classification may eventually intersect with embedding-based retrieval and the doc inconsistency will cause confusion.

**Verify:** `grep -rn "1536" --include="*.md" --include="*.ts" --include="*.tsx" .` returns only `.agent-os/` historical spec references.

### 2b: `runPrScan` signature change

**File:** `reviewService.ts:326`

```ts
// Before:
export async function runPrScan(
  prId: string,
  preloadedFiles?: any[],
  reviewRunId?: string,
): Promise<ScanResult>

// After:
export async function runPrScan(
  prId: string,
  preloadedFiles?: any[],
  reviewRunId?: string,
  reviewChunkId?: string,  // NEW — optional, for Large PR Mode attribution
): Promise<ScanResult>
```

When `reviewChunkId` is undefined (all existing callers), behavior is unchanged. When provided, the chunk ID is written to `ReviewFinding.reviewChunkId` and `ReviewLog.reviewChunkId` for scoping. This is a backward-compatible prep step — no behavior change.

**Verify:** `npm run lint` clean; existing tests still pass; existing scan endpoints work unchanged.

---

## Task 3: Schema — `ReviewChunk` model + related fields

**File:** `prisma/schema.prisma`

**New model** (place after `ReviewRun`, before `PullRequest`):

```prisma
model ReviewChunk {
  id              String   @id
  reviewRunId     String
  label           String   // human-readable, e.g. "apps/api/routes" or "src/components"
  filePaths       String[] // array of repo-relative file paths in this chunk
  status          String   // "pending" | "running" | "completed" | "failed" | "skipped"
  skipReason      String?  // mandatory when status = "skipped"
  rating          Int?
  summary         String?
  errorMessage    String?
  touchesSecuritySensitive Boolean @default(false)
  startedAt       DateTime?
  completedAt     DateTime?
  reviewRun       ReviewRun @relation(fields: [reviewRunId], references: [id], onDelete: Cascade)

  @@index([reviewRunId, status])
  @@map("review_chunks")
}
```

**Add to `ReviewRun`:**

```prisma
reliability      String?   // "complete" | "partial" | "incomplete_security_review"
chunksTotal      Int       @default(0)
chunksCompleted  Int       @default(0)
chunksFailed     Int       @default(0)
chunksSkipped    Int       @default(0)
reviewChunks     ReviewChunk[]
```

**Add to `ReviewFinding`:**

```prisma
reviewChunkId    String?
```

(Note: no FK relation — chunk deletion cascades through `ReviewRun`, findings stay searchable by `reviewRunId` regardless of chunk state. Index `@@index([reviewChunkId])` for chunk-scoped finding queries.)

**Add to `ReviewLog`:**

```prisma
reviewChunkId    String?
```

(Same — index, no FK relation.)

**Add to `Repository`:**

```prisma
securitySensitivePaths String[] @default([]) // user-configured glob patterns, seeded empty
```

Postgres `String[]` maps cleanly; no JSON encoding needed.

**Migration:**
- `npx prisma db push` (dev) or generate migration via `npx prisma migrate dev --name add_review_chunks`.
- No legacy data to synthesize — all existing `ReviewRun` rows get default values (`reliability: null`, `chunksTotal: 0`, etc.). The `reliability: null` correctly indicates "pre-Large-PR-Mode run, no chunked review."

**Verify:** `npx prisma db push` succeeds; `SELECT count(*) FROM review_chunks` returns 0; existing endpoints still work.

---

## Task 4: Diff Manifest — `src/services/largePrReview/manifest.ts`

**New file:** `src/services/largePrReview/manifest.ts` (~120 lines)

**Exports:**

```ts
export type FileClass = "code" | "docs" | "generated" | "lock" | "vendor";

export interface FileClassification {
  filename: string;
  additions: number;
  deletions: number;
  fileClass: FileClass;
}

export interface DiffManifest {
  files: FileClassification[];
  totalLines: number;        // additions + deletions across all files
  codeLines: number;         // lines in files classified as "code"
  codeFileCount: number;
  docsFileCount: number;
  generatedFileCount: number;
  sizeProfile: SizeProfile;  // from the prerequisite PR Size Profile utility
  tier: "normal" | "grouped" | "oversized";
}

export function buildDiffManifest(files: RepoFile[]): DiffManifest
export function assertTier(manifest: DiffManifest): TierResult
```

**Classification rules** (deterministic, no LLM):

| Class | Match | Examples |
|---|---|---|
| `lock` | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`, `*.lock` | lockfiles |
| `generated` | `*.min.js`, `*.generated.*`, `dist/`, `build/`, `.next/`, paths matching `// AUTO-GENERATED` header in first 5 lines | build artifacts |
| `vendor` | `vendor/`, `third_party/`, `node_modules/`, `.vendored/` | vendored deps |
| `docs` | `*.md`, `*.mdx`, `docs/`, `LICENSE`, `CHANGELOG*`, `.agent-os/`, `.github/` (excluding workflows) | documentation |
| `code` | everything else | source |

**Tier thresholds** (hardcoded for v1):

```ts
const NORMAL_MAX_LINES = 800;
const NORMAL_MAX_CODE_FILES = 40;
const OVERSIZED_LINES = 3000;
const OVERSIZED_CODE_FILES = 100;

export function assertTier(manifest: DiffManifest): TierResult {
  if (manifest.codeLines > OVERSIZED_LINES || manifest.codeFileCount > OVERSIZED_CODE_FILES) {
    return {
      ok: true,
      tier: "oversized",
      message: `Oversized PR (${manifest.codeLines} code lines, ${manifest.codeFileCount} code files). Split recommended; review will run best-effort in chunks.`,
    };
  }
  if (manifest.codeLines > NORMAL_MAX_LINES || manifest.codeFileCount > NORMAL_MAX_CODE_FILES) {
    return { ok: true, tier: "grouped" };
  }
  return { ok: true, tier: "normal" };
}
```

**Fail-open:** if classification throws on a malformed file, return a manifest with `tier: "normal"` and log the error — never block the scan.

**Verify:** unit test — a 500-line `src/foo.ts` → `tier: "normal"`. A 1500-line `src/foo.ts` → `tier: "grouped"`. A 4500-line `src/foo.ts` → `tier: "oversized"` with warning copy, not a refusal. A `package-lock.json` with 5000 lines → still `tier: "normal"` (lock class excluded from `codeLines`).

---

## Task 5: Chunker — `src/services/largePrReview/chunker.ts`

**New file:** `src/services/largePrReview/chunker.ts` (~180 lines)

**Exports:**

```ts
export interface ChunkPlan {
  label: string;            // e.g. "src/app/api" or "src/components/views"
  filePaths: string[];
  estimatedLines: number;
  touchesSecuritySensitive: boolean;  // computed via securitySensitive.ts
}

export function chunkDiff(
  manifest: DiffManifest,
  repoSecurityPaths: string[],
): ChunkPlan[]
```

**Algorithm (priority order, committed):**

```
1. Group files by monorepo package boundary.
   - Detect: paths under apps/<pkg>/, packages/<pkg>/, services/<pkg>/
   - Non-monorepo repos (no such structure) → single "root" package.
2. Within each package, group by file type bucket:
   - schema (prisma/*.prisma, *.sql migrations)
   - routes (src/app/api/**, routes/**)
   - components (src/components/**, *.tsx)
   - services (src/services/**, lib/**)
   - tests (*.test.*, __tests__/**)
   - other (catch-all)
3. Within each (package, type) bucket, split if estimated lines > 600.
   - Split heuristic: sort by directory prefix, partition at the line cap.
   - Resulting chunks labeled "<pkg>/<type>#1", "<pkg>/<type>#2", etc.
4. For each final chunk, compute touchesSecuritySensitive via securitySensitive.ts.
```

**600-line cap is a hard ceiling.** A single huge file (e.g., 1500-line `reviewService.ts`) gets its own chunk and is logged — no recursive split of individual files in v1 (would produce meaningless sub-file chunks).

**Determinism:** same manifest → same `ChunkPlan[]`, every time. No random IDs, no Map iteration order dependence (sort keys).

**Verify:** unit test — fixture manifest with files in `apps/api/routes/`, `apps/web/components/`, `packages/shared/` produces chunks aligned to those boundaries. Verify: a single 800-line file → one chunk, not split.

---

## Task 6: Security-Sensitive Classifier — `src/services/largePrReview/securitySensitive.ts`

**New file:** `src/services/largePrReview/securitySensitive.ts` (~100 lines)

**Three-tier matching.** A file is security-sensitive if it matches ANY tier:

```ts
export function isSecuritySensitive(
  filePath: string,
  repoConfiguredPaths: string[],
): boolean
```

**Tier 1: Global default globs** (hardcoded, ships with product):

```ts
const GLOBAL_DEFAULTS = [
  "src/app/api/auth/**",
  "src/app/api/webhooks/**",
  "src/app/api/hooks/**",
  "src/app/api/keys/**",
  "src/app/api/db/**",
  "src/app/api/repos/**/webhook/**",
  "src/app/api/repos/**/reindex/**",
  "src/app/api/prs/**/scan/**",
  "src/lib/apiAuth.ts",
  "src/lib/api-auth.ts",
  "src/lib/pathSafety.ts",
  "src/lib/crypto.ts",
  "src/lib/encryption.ts",
  "src/lib/webhookSetup.ts",
  "src/lib/gitRemote.ts",
  "prisma/schema.prisma",
  "prisma/migrations/**",
  ".env*",
];
```

**Tier 2: Keyword fallback** (hardcoded, accepts false positives for v1):

```ts
const KEYWORD_FALLBACK = [
  "**/*auth*",
  "**/*session*",
  "**/*token*",
  "**/*secret*",
  "**/*crypto*",
  "**/*encrypt*",
  "**/*decrypt*",
  "**/*webhook*",
  "**/*permission*",
  "**/*policy*",
  "**/*rbac*",
  "**/*acl*",
  "**/*sandbox*",
  "**/*pathSafety*",
];
```

**Tier 3: Repo-configured additions** (`Repository.securitySensitivePaths`, seeded `[]`):

```ts
// GrepLoop's own deployment would seed:
//   src/services/findingVerifier.ts
//   src/services/indexingService.ts
//   src/services/indexing/**
//   src/lib/reviewLocks.ts
//   src/lib/reviewFreshness.ts
```

**Glob matching:** use `picomatch` (already in `package-lock.json` via `vitest`/`vite` transitive — verify, otherwise add). No regex translation, just glob literals.

**Why accept false positives in Tier 2:** the cost is "rating null when it didn't need to be" — annoying but safe. The opposite (false negative) ships a false green on a security bug. v1.1 adds an override list (`securitySensitiveOverrides`) for paths that should NOT match despite keyword hits.

**Verify:** unit test — `src/lib/pathSafety.ts` → sensitive (Tier 1). `src/components/AuthTokenButton.tsx` → sensitive (Tier 2 keyword). `src/utils/format.ts` → not sensitive. `src/foo.ts` with repo config `["src/foo.ts"]` → sensitive (Tier 3).

---

## Task 7: Orchestrator — `src/services/largePrReview/orchestrator.ts`

**New file:** `src/services/largePrReview/orchestrator.ts` (~200 lines)

**Exports:**

```ts
export async function runLargePrReview(opts: {
  reviewRunId: string;
  prId: string;
  repoId: string;
  repoPath: string;
  files: RepoFile[];
  repoSecurityPaths: string[];
}): Promise<void>
```

**State machine:**

```
1. buildDiffManifest(files)
2. assertTier(manifest) → must be tier: "grouped" or "oversized" (caller checks; normal uses existing single-pass flow)
3. chunkDiff(manifest, repoSecurityPaths) → ChunkPlan[]
4. Write ReviewChunk rows: prisma.reviewChunk.createMany({ data: plans mapped to rows })
   - All rows start status: "pending"
   - touchesSecuritySensitive persisted at creation time (transparent to UI before scan runs)
5. Update ReviewRun: chunksTotal = plans.length
6. For each chunk, sequentially:
   a. Update ReviewChunk status → "running", startedAt = now
   b. Try:
      - Filter files to chunk.filePaths
      - await runPrScan(prId, filteredFiles, reviewRunId, chunk.id)
      - On success: update chunk status → "completed", rating, summary, completedAt
      - Increment ReviewRun.chunksCompleted
   c. Catch transient errors (timeout, invalid JSON, network):
      - If first failure: retry once
      - If second failure: update chunk status → "failed", errorMessage
      - Increment ReviewRun.chunksFailed
   d. Catch deterministic errors (schema validation, code errors):
      - Mark failed immediately, no retry
7. After all chunks: call aggregateResults(reviewRunId)
```

**Lock handling:** the entry-point route (Task 9) acquires `acquireReviewLock(prId, force)` BEFORE calling `runLargePrReview`. The orchestrator does NOT acquire its own lock. The orchestrator's try/finally MUST NOT release the lock — that's the entry-point route's responsibility. (Rationale: lock ownership stays at the route layer for symmetry with the existing single-pass flow.)

**Circuit breaker:** if 3 consecutive chunks fail with the same `errorMessage`, skip remaining chunks (`status: "skipped"`, `skipReason: "circuit_breaker: <error>"`). Mirrors `embeddingService.ts` pattern — don't burn budget on a known-bad config.

**Idempotent retry:** the "Retry failed chunks" UI button calls a new endpoint that:
1. Loads the `ReviewRun` and all `ReviewChunk` rows where `status = "failed"`.
2. For each: status → "running", re-runs `runPrScan` with the chunk's files, status → "completed" or "failed".
3. Other chunks (completed/skipped) are NOT touched.
4. Re-runs `aggregateResults(reviewRunId)` at the end.

**Verify:** integration test — 3 chunks, middle chunk's `runPrScan` throws once then succeeds → chunk ends `completed`, run ends `complete`. Middle chunk throws twice → chunk ends `failed`, run ends `partial` (or `incomplete_security_review` if chunk was security-sensitive).

---

## Task 8: Aggregator — `src/services/largePrReview/aggregator.ts`

**New file:** `src/services/largePrReview/aggregator.ts` (~150 lines)

**Exports:**

```ts
export async function aggregateResults(reviewRunId: string): Promise<{
  reliability: "complete" | "partial" | "incomplete_security_review";
  finalRating: number | null;
  chunksCompleted: number;
  chunksFailed: number;
  chunksSkipped: number;
  skippedReasons: { chunkLabel: string; reason: string }[];
}>
```

**Algorithm:**

1. Load all `ReviewChunk` rows for the run.
2. Compute counters: `chunksCompleted`, `chunksFailed`, `chunksSkipped`.
3. Build `skippedReasons` from chunks where `status = "skipped"`.
4. **Reliability verdict:**
   - If any chunk with `touchesSecuritySensitive = true` has `status` in `["failed", "skipped"]` → `incomplete_security_review`, `finalRating = null`.
   - Else if any chunk has `status` in `["failed", "skipped"]` → `partial`, `finalRating = average of completed chunk ratings` (weighted by chunk line count if available, simple mean otherwise).
   - Else (all completed) → `complete`, `finalRating = weighted average`.
5. **Dedup findings:** query `ReviewFinding` where `reviewRunId = reviewRunId`, group by `(filename, line, category)`, keep one representative per group (highest `confidence` if set, else first by `createdAt`). Delete the duplicates via `prisma.reviewFinding.deleteMany({ where: { id: { in: duplicateIds } } })`.
6. Update `ReviewRun`: `reliability`, `chunksCompleted`, `chunksFailed`, `chunksSkipped`, `rating = finalRating`, `status = "completed"`, `completedAt = now`.
7. Call `completeReviewRun(reviewRunId, { status: "completed", rating: finalRating })` for consistency with existing lifecycle.

**Idempotency:** re-running `aggregateResults` on the same completed chunks must produce the same `finalRating`. Achieved by:
- Deterministic chunk ordering in queries (sort by `id` or `createdAt`).
- Deterministic dedup tiebreaker (sort by `confidence DESC, createdAt ASC`).
- No `Math.random()` or `Date.now()` in the rating calculation.

**Deterministic checks dedup:** if `runPrScan` already runs `tsc`/`eslint` per chunk, the same lint error appears N times across chunks that share imports. The aggregator's `(filename, line, category)` dedup handles this — but **preferred path** is for Task 9's route integration to invoke deterministic checks ONCE at the run level, not per chunk. v1 implements the dedup approach (simpler, ships faster); the refactor to run-level deterministic checks is v1.1.

**Verify:** unit test — 3 chunks with overlapping findings (chunk 1 and chunk 2 both report `src/foo.ts:42` as a security issue) → final findings list has one entry. Re-run aggregation → same `finalRating` (idempotency).

---

## Task 9: Route integration + UI

### 9a: Route entry-point detection

**Files:** `src/app/api/prs/[prId]/scan/route.ts`, `src/app/api/prcheck/[prIdOrNumber]/route.ts`, `src/app/api/hooks/prepush/route.ts`, `src/app/api/command/[[...args]]/route.ts`.

After `refreshPrFiles` and `createReviewRun`, insert tier check:

```ts
const manifest = buildDiffManifest(files);
const tierResult = assertTier(manifest);

if (tierResult.tier === "grouped" || tierResult.tier === "oversized") {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  await runLargePrReview({
    reviewRunId, prId, repoId, repoPath: repo.path,
    files, repoSecurityPaths: repo.securitySensitivePaths,
  });
  // Aggregator already completed the run; load and return
  const run = await prisma.reviewRun.findUnique({ where: { id: reviewRunId } });
  return NextResponse.json({
    status: "Success",
    largePrMode: true,
    sizeProfile: manifest.sizeProfile,
    tier: tierResult.tier,
    warning: tierResult.tier === "oversized" ? tierResult.message : null,
    reviewRun: run,
  });
}

// tier === "normal" — existing single-pass flow continues unchanged
```

**Lock acquired before** the tier check, released in the route's existing finally block.

### 9b: Retry-failed-chunks endpoint

**New file:** `src/app/api/prs/[prId]/runs/[runId]/retry-failed-chunks/route.ts`

```ts
export async function POST(req: Request, { params }: { params: Promise<{ prId: string; runId: string }> }) {
  // Auth, load run, acquire lock (force=false — refuse if other scan running)
  // Load chunks where reviewRunId = runId AND status = "failed"
  // For each: status → "running", re-run runPrScan with chunk files, status → "completed" or "failed"
  // Re-run aggregateResults(runId)
  // Release lock, return updated run
}
```

### 9c: UI — `src/components/views/prs/LargePrModePanel.tsx`

**New file:** `src/components/views/prs/LargePrModePanel.tsx` (~150 lines).

Renders when `reviewRun.chunksTotal > 0`:
- Banner: "Large PR Mode: {chunksTotal} chunks"
- Size Profile chip: `small | medium | large | oversized`; oversized copy says "split recommended" but does not imply the scan was blocked.
- Per-chunk progress list: label, status badge (`pending`/`running`/`completed`/`failed`/`skipped`), rating if completed, error message if failed, `touchesSecuritySensitive` icon.
- Failed-chunk retry button: POSTs to `/api/prs/{prId}/runs/{runId}/retry-failed-chunks`.
- Final verdict line: "Reliability: complete" (green) / "partial" (amber) / "incomplete_security_review" (red, with tooltip explaining that a security-sensitive chunk failed).

Mount in `ReviewCard.tsx` above the findings list.

### 9d: Banner disclosure

The Large PR Mode panel shows a persistent note:

> Cross-chunk bugs may be missed. Caller in chunk A and callee in chunk B are not jointly analyzed.

This is the honest disclosure of v1's known limitation.

**Verify:** end-to-end — register a PR with a synthetic 1200-line diff, trigger scan via `/api/prcheck/<id>`, confirm: tier detection routes to Large PR Mode, ReviewChunk rows created, chunks scanned sequentially, aggregation produces `reliability: "complete"` (or `partial`/`incomplete_security_review` if any fail), UI shows the panel.

---

## Task 10: Tests

**New test files under `tests/largePrMode/`:**

1. **`manifest.test.ts`** — `buildDiffManifest` classifies lockfiles/docs/generated correctly. `assertTier` returns correct tier for various line/file counts. Fail-open on malformed input.
2. **`chunker.test.ts`** — chunk boundaries respect monorepo package → file type → 600-line cap. Deterministic output (same manifest → same plan).
3. **`securitySensitive.test.ts`** — Tier 1/2/3 matching. False-positive acceptance for Tier 2 keywords.
4. **`orchestrator.test.ts`** — sequential chunk execution, retry-once on transient failure, circuit breaker trips after 3 consecutive failures.
5. **`aggregator.test.ts`** — dedup by `(filename, line, category)`. Reliability verdict correct for all-chunks-completed / one-failed / one-security-sensitive-failed. **Idempotency: re-running aggregation produces same finalRating.**
6. **`chunkBoundary.test.ts`** — a finding citing `file A` never appears in chunk B's persisted `reviewChunkId`. **Chunk-boundary correctness invariant.**
7. **`e2e.test.ts`** (integration) — full flow: manifest → chunk → run → aggregate → ReviewRun final state matches expectations. Use mocked `runPrScan` to avoid LLM calls in CI.

**Existing tests must still pass** — backward-compat invariant for `runPrScan` signature change.

**Final verification (manual):**
1. `npm run lint` clean.
2. `npm test` — all existing tests + new tests pass.
3. `npm run build` — production build succeeds.
4. Self-scan: trigger a scan on a synthetic 1200-line PR (e.g., create a feature branch with enough changes), confirm Large PR Mode activates, chunks complete, aggregation produces a verdict.
5. Trigger a synthetic 4000-code-line PR. Confirm it is marked `oversized`, displays "split recommended", still routes to Large PR Mode best-effort, and only ends rating `null` if chunks fail or a security-sensitive chunk is incomplete.

---

## Critical files referenced (read these before starting)

- `reviewService.ts:326` — `runPrScan` signature (adding `reviewChunkId?`)
- `src/lib/reviewLocks.ts:71-98` — `acquireReviewLock` discriminated-union pattern (reuse unchanged)
- `src/lib/reviewFreshness.ts` — `createReviewRun`, `completeReviewRun` lifecycle helpers (extend with reliability/counters)
- `src/lib/getRealLocalPrs.ts:44-52, 243-271` — `RepoFile` shape + `refreshPrFiles` (diff source)
- `src/lib/indexFreshness.ts:25-85` — discriminated-union pattern to mirror for `assertTier`
- `src/services/findingVerifier.ts` — post-processing pipeline pattern (mirrors aggregator's per-finding work)
- `src/services/embeddingService.ts` — circuit-breaker pattern (mirror for chunk circuit breaker)
- `prisma/schema.prisma:23-58` — `Repository` model (adding `securitySensitivePaths`)
- `prisma/schema.prisma:87-107` — `ReviewRun` model (adding reliability + counters)
- `prisma/schema.prisma:145-170` — `ReviewFinding` model (adding `reviewChunkId`)
- `src/app/api/prs/[prId]/scan/route.ts` — primary scan entry point (insert tier check)
- `src/app/api/prcheck/[prIdOrNumber]/route.ts:60-110` — CLI entry point (insert tier check)
- `src/components/views/prs/ReviewCard.tsx` — UI host for new LargePrModePanel
- `.agent-os/specs/2026-06-24-1746-review-freshness-guard/plan.md` — closest prior spec for format
