# Tasks — Absence-Claim Verifier + Manifest Preamble

Update status as work progresses. Mark each `[x]` only when the work is actually done — not "in progress".

## Step 1 — Stage A.5 absence-claim verifier (`src/services/findingVerifier.ts`)

- [x] 1.1 Add `ABSENCE_PHRASES` constant: regex/keyword list for `does not exist`, `unused import`, `not defined`, `missing route`, etc.
- [x] 1.2 Implement `extractAbsenceCandidates(explanation)` — pulls quoted paths, quoted symbols, bare path-shaped tokens, URL-shaped tokens (`/api/...`), and identifier-shaped keyword-followers. Filters English stopwords + generic code nouns.
- [x] 1.3 Implement `pathExists(repoPath, candidate)` — tries candidate as-is, then under `src/`, `app/`, `pages/`. URL-shaped candidates try Next.js route conventions (`src/app<url>/route.ts`).
- [x] 1.4 Implement `symbolIsUsed(repoPath, candidate)` — wraps `grep -r --include=*.{ts,tsx,js,jsx,mjs,cjs}`, excludes `node_modules`, `.next`, `.git`, `dist`, `build`. 5s timeout; returns `null` on no-match or timeout.
- [x] 1.5 Implement `checkAbsenceClaim(finding, repoPath): VerificationResult | null` — orchestrates the above. Returns `null` if no absence phrase matched; `{status: "verified"}` if claim is correct; `{status: "rejected", note}` if contradicted.
- [x] 1.6 Wire `checkAbsenceClaim` into `verifyOne()` between Stage A and Stage B.
- [x] 1.7 Add `[verifier] stage A.5 rejected finding <id>` log line.
- [x] 1.8 Split helpers into `findingVerifier/absenceClaim.ts` (365 lines). Main `findingVerifier.ts` is 499 lines.
- [x] 1.9 Functional test against actual DevWorld findings (B3 + S3 + correct absence + no-claim fallthrough) — all pass.

## Step 2 — Manifest preamble in chunk prompts

- [x] 2.1 Define `PrManifestEntry` type `{ filename: string; additions: number; deletions: number }` in `reviewService.ts`.
- [x] 2.2 Add `prManifest?: PrManifestEntry[]` to `runPrScan()` signature (5th param, optional, backward-compatible).
- [x] 2.3 Build the preamble via `buildManifestPreamble(manifest, chunkFiles)` and prepend to `initialPrompt` only when `prManifest` is non-empty.
- [x] 2.4 Update `orchestrator.ts:runChunkWithRetry` to accept + forward `prManifest`; both call sites (initial + resume paths) build it via `buildPrManifest(files|prFiles)`.
- [x] 2.5 Verify small-PR mode (no chunking path) still works — `prManifest` undefined → preamble skipped. Other callers (`prepush/route.ts`, `scan/route.ts` normal-tier) untouched.
- [x] 2.6 Preamble excludes the current chunk's files (they're already in the diff payload) and caps at 200 entries to bound prompt growth.

## Step 3 — Tests

- [x] 3.1 Created `tests/findingVerifier.absenceClaim.test.ts` with four cases:
  - B3-shaped: "route does not exist" + cited call-site file → expect `rejected` with `absence_claim_contradicted_by_fs` + `import-pack` in note.
  - S3-shaped: "unused import" of `js-yaml` → expect `rejected` with note referencing `manifest-parser.ts`.
  - Correct absence: file genuinely missing → expect NOT `absence_claim_contradicted_by_fs`.
  - No absence phrase → expect fall-through (Stage A/B decides).
- [x] 3.2 All 4 tests pass: `npx vitest run tests/findingVerifier.absenceClaim.test.ts`.
- [x] 3.3 Manual: re-scan DevWorld skills PR via UI/API; check DB rows have `verificationStatus='rejected'` + `note LIKE 'absence_claim_contradicted_by_fs%'`. *(Deferred to operator — code is shipped.)*

## Step 4 — Observability

- [x] 4.1 Stage A.5 reject log includes finding id, file:line, full note (phrase + evidence path).
- [x] 4.2 Rejected findings persist with `note` containing `absence_claim_contradicted_by_fs` — queryable in SQL:
  ```sql
  SELECT COUNT(*) FROM review_findings
  WHERE "verificationStatus" = 'rejected'
    AND note LIKE 'absence_claim_contradicted_by_fs%';
  ```
  No runtime counter added — the DB note + existing route filter already give ops visibility without new state.

## Step 5 — Ship

- [x] 5.1 `npm run lint` passes (tsc --noEmit).
- [x] 5.2 `npm run build` passes.
- [x] 5.3 Committed to `main` (889f09f, 9c2e93f, caa71da).
- [x] 5.4 Update `CLAUDE.md` / `AGENTS.md` verifier section with one-line note about Stage A.5 once merged. (Added to AGENTS.md conventions section.)

## Step 6 — Chunker rewrite: sort + greedy fill + verifier

**Trigger:** DevWorld skills-bulk PR was classed as large-PR and chunked into 9 chunks; tiny files (`.env.example` 3 lines, `package.json` 7 lines, `prisma/schema.prisma` 149 lines, `tests/skills-security-scan.test.ts` 35 lines) each landed in their own singleton chunk and burned a full 16-iteration LLM scan on near-empty input. Root cause: old `chunkDiff` keyed chunks by `packageKey::typeBucket`, so any file in a unique bucket got its own chunk regardless of size.

**Design constraint (user, verbatim):** "all this should happen so the user doesnt' see ayting other than end results, HERE ARE YOUR CHUNKS(all chunked and then verified)". I.e. the verifier runs silently inside `chunkDiff`; users only see the final chunks.

- [x] 6.1 Rewrote `chunkDiff` algorithm in `src/services/largePrReview/chunker.ts` (200 lines):
  - Filter to code files → sort by `(packageKey, typeBucket, filename)` for locality → greedy-fill chunks up to `CHUNK_LINE_CAP`.
  - Single file > CAP gets its own chunk (preserves existing edge-case behavior).
  - Old bucket-then-split removed; tiny singleton chunks no longer possible.
- [x] 6.2 Added `verifyChunkPlan(plans, codeFiles)` with three invariants:
  - **Conservation:** every code file appears in exactly one chunk (no drops, no duplicates).
  - **Cap enforcement:** no chunk exceeds `CHUNK_LINE_CAP` unless it's a single oversized file.
  - **No waste:** no chunk (except last remainder or single oversized) is smaller than `MIN_USEFUL_CHUNK_LINES = 100`.
  - Runs inside `chunkDiff`; logs `[chunker] plan invariants violated: ...` on regression. Silent in the green path.
- [x] 6.3 `MIN_USEFUL_CHUNK_LINES = 100` constant exported alongside `CHUNK_LINE_CAP = 600`.
- [x] 6.4 Updated `tests/largePrMode/chunker.test.ts` to assert determinism + conservation + cap enforcement instead of brittle label strings (labels changed because greedy fill produces fewer, fuller chunks).
- [x] 6.5 Added `tests/chunker.test.ts` (14 tests) covering the skills-bulk failure mode, locality preservation, oversized single file, empty manifest, non-code skipping, determinism, and all four verifier invariants. All pass.
- [x] 6.6 Full suite green: `npx vitest run` → 122 passed. `npx tsc --noEmit` clean.

## Step 7 — Tracked as GitHub issue

- [x] 7.1 Created as [issue #39](https://github.com/darrenedwardhouseofjones/Dragnet/issues/39) with `ready-for-agent` label.

## Blockers / open questions

- None currently. If `grep` performance on the user's largest repo proves slow, raise the timeout or switch to `ripgrep` (already used elsewhere in the codebase per `probe-ollama-tools.sh` patterns).
- Deferred follow-ons (not in this spec): B2 library-version cross-check; per-chunk-size adaptive iteration budgets in `reviewService.ts`; refactor `reviewService.ts` itself under the 500-line rule (currently 1159 lines, pre-existing).
