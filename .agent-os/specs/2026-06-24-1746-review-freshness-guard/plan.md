# Plan — Review Freshness Guard + v1 Finding Verifier

## Context

**The bug this fixes.** On 2026-06-24, an AI scan of `feature/bug-demo` returned a 4/10 rating with 8 findings — 3 of 4 BLOCKERS cited code that had already been fixed in commit `2e4113e` ("close 4 security gaps found in AI code review") days earlier. The scanner reported against stale state: `authenticateIfExternal` was renamed, `gitRemote.buildSshEnv` was switched to `mkdtempSync`, `findPrByIdOrNumber` was scoped to `repoId`. None of these exist in current code.

**Root cause.** Two layered failures, both addressable:

1. **No freshness invariant.** `runPrScan` (reviewService.ts:536) does `reviewFinding.deleteMany({ where: { prId } })` on every scan, then writes new findings. There's no record of *which commit/diff/config* produced a given batch. `GET /api/prs/[prId]/findings` returns whatever's in the table — no filter, no "reviewed commit" badge, no way to tell if the findings match the PR's current state. The UI (`ReviewCard.tsx:126-162`) has no notion of freshness either.

2. **No verifier.** PRD §14.6 (`prd.md:340`) flags this: "Candidate findings are persisted after enum clamping but before evidence validation or counter-evidence verification. Add the verifier before rendering blockers." Findings citing non-existent lines or already-fixed code currently survive to the UI unchecked.

**Outcome.** After this spec ships:
- Every scan is recorded as a `ReviewRun` with `(prId, commitHash, diffHash, reviewConfigHash)`.
- Re-scans with unchanged inputs short-circuit (no LLM cost); `force=true` bypasses.
- The findings route returns only the latest completed run matching current state — older runs are history, never "current."
- The UI shows "Reviewed commit: abc1234 · diff a1b2…" next to the report.
- A v1 verifier validates cited lines/files and runs targeted counter-evidence retrieval for auth, data-isolation, webhook/network, and concurrency findings. Rejected findings are collapsed, not displayed as blockers.

**Decisions locked with user (2026-06-24):**
- **Schema:** full `ReviewRun` model — single source of truth. Findings get `reviewRunId` FK. Aligns with PRD §14.7's ReviewPass hook ("should land before Phase 1.5").
- **Short-circuit:** when a completed ReviewRun exists for the same `(prId, commitHash, diffHash, reviewConfigHash)`, return it as current. `force=true` to bypass.
- **Verifier scope:** v1 = line/file validation + targeted counter-evidence for 4 high-stakes categories (auth, data isolation, webhook/network, concurrency). Separate from freshness — freshness = "right diff"; verifier = "correct *about* that diff." Full PRD §14.6 5-class classification deferred.

**Out of scope (follow-on specs):**
- Full verifier taxonomy (`confirmed`/`likely`/`partially_mitigated`/`needs_verification`/`false_positive`).
- Multi-model ensemble reconciliation (PRD §14.5).
- Verifier for categories beyond the 4 v1 targets.

---

## Task 1: Save Spec Documentation

Create `.agent-os/specs/2026-06-24-1746-review-freshness-guard/` with five files matching the convention (see `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/`):

- **plan.md** — this plan, verbatim
- **shape.md** — scope, decisions, context (per shape-spec template)
- **standards.md** — relevant standards (project has no `.agent-os/standards/index.yml`; document the implicit standards being applied: 500-line rule, lazy-singleton pattern, discriminated-union return shape mirroring `assertIndexFresh`)
- **references.md** — pointers to `indexFreshness.ts` (pattern to mirror), `reviewService.ts:534-579` (write path), `getRealLocalPrs.ts:243-271` (diff source), `.agent-os/specs/2026-06-23-2031-index-freshness-gates/plan.md` (prior freshness spec for format)
- **tasks.md** — phase-grouped `- [ ]` checkboxes, updated as work ships

---

## Task 2: Schema — ReviewRun model + ReviewFinding FK

**File:** `prisma/schema.prisma`

**New model** (place after `ReviewHistory`, before `PullRequest`):

```prisma
model ReviewRun {
  id               String         @id
  prId             String
  repoId           String
  commitHash       String
  diffHash         String
  reviewConfigHash String
  status           String         // "in_progress" | "completed" | "failed"
  startedAt        DateTime
  completedAt      DateTime?
  model            String?
  rating           Int?
  triggerReason    String?        // "manual" | "prepush" | "prcheck" | "webhook" | "legacy"
  forced           Boolean        @default(false)
  pullRequest      PullRequest    @relation(fields: [prId], references: [id], onDelete: Cascade)
  reviewFindings   ReviewFinding[]

  @@index([prId, status, completedAt])
  @@map("review_runs")
}
```

**Add to `ReviewFinding`:**

```prisma
model ReviewFinding {
  id                 String      @id
  prId               String
  reviewRunId        String      // NEW — FK to ReviewRun
  repoId             String
  category           String
  severity           String
  filename           String
  line               Int?
  explanation        String
  diffSuggestion     String?
  evidenceChain      String?
  confidence         Float?
  verificationStatus String?     // NEW — "verified" | "downgraded" | "rejected" | "unverified"
  verificationNote   String?     // NEW — short reason if downgraded/rejected
  timestamp          String
  pullRequest        PullRequest    @relation(fields: [prId], references: [id], onDelete: Cascade)
  reviewRun          ReviewRun      @relation(fields: [reviewRunId], references: [id], onDelete: Cascade)

  @@index([reviewRunId])
  @@map("review_findings")
}
```

**Add to `PullRequest`:**

```prisma
  reviewRuns   ReviewRun[]
```

**Migration — legacy data handling.** Existing `ReviewFinding` rows have no `reviewRunId`. For each distinct `prId` in `review_findings`, synthesize one legacy `ReviewRun` row with `status: 'completed'`, `diffHash: ''`, `reviewConfigHash: ''`, `commitHash: <pr.commitHash>`, `startedAt`/`completedAt: <min(finding.timestamp)>`, `model: null`, `triggerReason: 'legacy'`. They naturally fall out of "current" once a fresh scan produces a real hash.

**Files also touched:**
- `prisma/migrations/<timestamp>_review_runs/migration.sql` — up + down
- `src/generated/prisma/` — regenerated via `npx prisma generate`

**Verify:** `npx prisma db push` succeeds; `SELECT count(*) FROM review_runs WHERE trigger_reason = 'legacy'` matches distinct PRs with existing findings.

---

## Task 3: Freshness helpers — `src/lib/reviewFreshness.ts`

**New file:** `src/lib/reviewFreshness.ts` (~180 lines)

Mirror the discriminated-union pattern from `src/lib/indexFreshness.ts:25-85` (`assertIndexFresh`). Fail-open on git/parser errors — never block scans on hash computation failures.

**Exports:**

```ts
export function computeDiffHash(files: RepoFile[]): string
export function computeReviewConfigHash(
  chatChain: { name: string; model: string }[],
  systemPromptHash: string,
): string
export async function assertReviewFreshness(
  pr: { id: string; commitHash: string },
  currentDiffHash: string,
  currentConfigHash: string,
): Promise<
  | { ok: true; runId: string }
  | { ok: false; kind: "NO_RUN" | "STALE_RUN"; message: string }
>
export async function createReviewRun(opts: {
  prId: string; repoId: string; commitHash: string;
  diffHash: string; reviewConfigHash: string;
  model?: string; triggerReason?: string; forced?: boolean;
}): Promise<string>
```

**Implementation notes:**
- `computeDiffHash`: filter `files` to those with non-empty `diff`, sort by `filename` (stable), concatenate `diff` strings with `\n---\n` separators, sha256, hex, 16 chars.
- `computeReviewConfigHash`: concatenate `chatChain.map(c => c.model).join(",")` + `|` + `systemPromptHash`, sha256, hex, 16 chars.
- `assertReviewFreshness`: query latest completed run for `prId`. If `commitHash + diffHash + reviewConfigHash` all match → `{ ok: true, runId }`. Else → `{ ok: false, kind: 'STALE_RUN' }`. If no completed run exists → `kind: 'NO_RUN'`.

**Verify:** unit test — two `computeDiffHash` calls on identical input produce identical hashes; reordering the `files` array produces the same hash (sort makes it stable).

---

## Task 4: Wire short-circuit + ReviewRun lifecycle into scan route

**File:** `src/app/api/prs/[prId]/scan/route.ts` (currently 114 lines)

**New flow** (replaces lines 48-98):

1. After resolving repo + PR (existing L28-46), compute `currentDiffHash` from a `refreshPrFiles` call (existing L90). **Move** `refreshPrFiles` to *before* the freshness check — its output is needed for `computeDiffHash` regardless of cache hit.
2. Compute `currentConfigHash` from `getChatChain()` + system prompt hash (from `reviewService.ts`).
3. Check `force` query param: `const force = new URL(req.url).searchParams.get('force') === 'true'`.
4. If `!force`: call `assertReviewFreshness(pr, currentDiffHash, currentConfigHash)`. On `{ ok: true, runId }` → return `200 { cached: true, runId, rating, findings }` (findings loaded via `prisma.reviewFinding.findMany({ where: { reviewRunId: runId, verificationStatus: { not: 'rejected' } } })`).
5. Otherwise: create `in_progress` ReviewRun via `createReviewRun(...)`.
6. Pass `reviewRun.id` into `runPrScan(prId, files, reviewRun.id)`.
7. On success: `runPrScan` flips the run to `completed` + sets `rating`/`completedAt`. On failure: scan route's existing catch block flips it to `failed`.

**Backward compat:** the other scan paths (`/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command/[[...args]]`) call `runPrScan` directly. They create their own `in_progress` ReviewRun via `createReviewRun` helper.

**Verify:** scan a PR, confirm `review_runs` row created with `status: in_progress` → flips to `completed` on success. Re-scan with no diff change → cached 200, no new row.

---

## Task 5: v1 Finding Verifier — `src/services/findingVerifier.ts`

**New file:** `src/services/findingVerifier.ts` (~280 lines)

**Scope (locked with user):**
- Line/file validation for **all** findings.
- Targeted counter-evidence retrieval for **4 categories**: `auth`, `data-isolation`, `webhook/network`, `concurrency`.

**Exports:**

```ts
export interface VerificationResult {
  status: "verified" | "downgraded" | "rejected" | "unverified";
  note: string;
}

export async function verifyFindings(
  findings: CandidateFinding[],
  repoPath: string,
  repoId: string,
): Promise<Map<string, VerificationResult>>
```

**Two-stage process per finding:**

### Stage A — line/file validation (all findings)

1. Load `repoPath/filename` from disk (or `originalContent`/`modifiedContent` from the PR's `PrFile` row if the file is part of the diff). If file doesn't exist → `rejected`, note `"cited file does not exist"`.
2. Check `line` is within file bounds. If out of range → `rejected`, note `"cited line N is outside file (1..M)"`.
3. Substring check: does the code at `line ±5` contain the symbol/pattern the finding's `explanation` references? If obvious mismatch (e.g., finding cites `authenticateIfExternal` at line 54 but line 54 contains `authenticateSessionOrKey`) → `rejected`, note `"cited code does not match finding claim"`.

### Stage B — counter-evidence retrieval (4 categories only)

| Finding signals | Counter-evidence retrieval |
|---|---|
| `Security` + explanation mentions `auth`/`session`/`api key`/`bearer`/`cookie` | Grep repo for `requireSession`, `authenticateSessionOrKey`, `authenticateApiRequest`, `verifyGithubSignature`. If found in cited file or its callers → LLM-assisted downgrade. |
| `Security` + explanation mentions `tenant`/`repoId`/`isolation`/`cross-repo` | Read the cited function; check for `where: { repoId, ... }` clauses. If scoping present → downgrade. |
| `Security` + explanation mentions `webhook`/`hmac`/`signature`/`host`/`origin` | Grep for HMAC verification, signature checks, allowlists. If present → downgrade. |
| `Correctness` + explanation mentions `race`/`concurrency`/`transaction`/`lock` | Read the cited function; check for `beginReview`/`endReview`, `$transaction`, atomic upserts. If present → downgrade. |

LLM-assisted verdict: load cited file + 50 lines of context + retrieved counter-evidence snippets, ask `getChatChain()[0]`:

> Given the finding and this actual code, does the finding still apply? Respond with one of: `verified`, `downgraded`, `rejected`. One-sentence reason.

Parse LLM response, fall back to `unverified` on parse failure. Never throw — verifier failure must not block persistence.

**Verify:** unit test — finding citing non-existent file → rejected. Finding citing real file but wrong symbol → rejected. Finding citing real issue → verified.

---

## Task 6: Wire verifier into `runPrScan` + manage ReviewRun lifecycle

**File:** `reviewService.ts`

**Signature change:**

```ts
// Before:
export async function runPrScan(prId: string, files: any[]): Promise<ScanResult>

// After:
export async function runPrScan(
  prId: string,
  files: any[],
  reviewRunId: string,
): Promise<ScanResult>
```

Update all callers: `/api/prs/[prId]/scan`, `/api/hooks/prepush`, `/api/prcheck/[prIdOrNumber]`, `/api/command/[[...args]]`. Each creates its own `in_progress` ReviewRun via `createReviewRun` before calling.

**New persistence flow:**

1. After the agentic loop produces `candidateFindings`, call `verifyFindings(candidateFindings, repoPath, repoId)`.
2. Build `findingsData` with `verificationStatus` + `verificationNote` from the verifier map. **All** findings persist (including `rejected` ones, for audit trail) — the UI filter is what hides them.
3. `prisma.reviewFinding.deleteMany({ where: { prId } })` → keep as-is.
4. `prisma.reviewFinding.createMany({ data: findingsData })` with `reviewRunId` on each row.
5. `prisma.reviewRun.update({ where: { id: reviewRunId }, data: { status: 'completed', rating, completedAt: new Date() } })`.
6. On catch: `prisma.reviewRun.update({ where: { id: reviewRunId }, data: { status: 'failed', completedAt: new Date() } })`.

**Verify:** scan completes → ReviewRun flips to `completed`; verifier ran (visible in `verificationStatus` column diversity); rejected findings still in DB but hidden by route filter.

---

## Task 7: Findings route + UI

**File:** `src/app/api/prs/[prId]/findings/route.ts` (currently 13 lines)

**New logic:**

```ts
const latestRun = await prisma.reviewRun.findFirst({
  where: { prId, status: "completed" },
  orderBy: { completedAt: "desc" },
});

if (!latestRun) {
  return NextResponse.json({
    reviewRun: null,
    findings: [],
    stale: true,
    message: "No completed review yet. Run a scan.",
  });
}

const currentDiffHash = await computeDiffHashFromPrFiles(prId);
const stale = latestRun.diffHash !== currentDiffHash;

const findings = await prisma.reviewFinding.findMany({
  where: { reviewRunId: latestRun.id, verificationStatus: { not: "rejected" } },
});

return NextResponse.json({
  reviewRun: {
    id: latestRun.id,
    commitHash: latestRun.commitHash,
    diffHash: latestRun.diffHash,
    completedAt: latestRun.completedAt,
    rating: latestRun.rating,
    stale,
  },
  findings,
  rejectedCount: await prisma.reviewFinding.count({
    where: { reviewRunId: latestRun.id, verificationStatus: "rejected" },
  }),
});
```

**File:** `src/components/views/prs/ReviewCard.tsx` (lines 126-162)

**UI changes:**

1. Header: add badge `Reviewed commit: {reviewRun.commitHash.slice(0, 7)}` + relative timestamp. If `reviewRun.stale` → amber `⚠ stale` chip + tooltip.
2. Below findings list: collapsible `<details>` "Verifier filtered: N findings" showing rejected findings with their `verificationNote`. Off by default.
3. Each finding: small chip showing `verificationStatus` if not `verified`.

**Verify:** load dashboard, scan a PR, confirm badge appears with correct commit prefix. Modify the PR diff, reload, confirm `stale` chip appears.

---

## Task 8: Tests + final verification

**New test files:**
- `tests/reviewFreshness.test.ts` — `computeDiffHash` stability across input reordering; `assertReviewFreshness` returns correct discriminated union.
- `tests/findingVerifier.test.ts` — fixture findings citing non-existent files → rejected; fixture findings citing real code with the claimed issue → verified.
- `tests/scanCache.test.ts` — integration: scan → re-scan with no changes → second call short-circuits.

**Final verification (manual):**
1. `npm run lint` clean.
2. `npm test` — all existing 55 tests pass + new tests pass.
3. `npm run build` — production build succeeds.
4. Self-scan: clear findings for `feature/bug-demo`, refresh files, re-scan. Confirm the 3 false-positive blockers from the original scan are either absent (diffHash changed) or marked `rejected` by the verifier.
5. Re-scan with no changes → cached 200, no LLM cost.
6. UI shows "Reviewed commit: … · diff …" next to the report.

---

## Critical files referenced (read these before starting)

- `prisma/schema.prisma:111-127` — ReviewFinding model (adding FK)
- `prisma/schema.prisma:76-93` — PullRequest model (adding reviewRuns relation)
- `src/lib/indexFreshness.ts:25-85` — discriminated-union pattern to mirror
- `src/lib/getRealLocalPrs.ts:44-52, 243-271` — `RepoFile` shape + `refreshPrFiles` (diff source)
- `src/app/api/prs/[prId]/scan/route.ts:48-98` — scan route flow to modify
- `src/app/api/prs/[prId]/findings/route.ts` — 13-line route to extend
- `reviewService.ts:534-579` — persistence block to modify
- `src/components/views/prs/ReviewCard.tsx:126-165` — UI to extend
- `.agent-os/specs/2026-06-23-2031-index-freshness-gates/plan.md` — prior freshness spec, format template
- `prd.md:340-341` — §14.6/14.7 gap audit (verifier + ReviewPass)
