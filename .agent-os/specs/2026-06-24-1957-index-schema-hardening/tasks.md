# Tasks — Index Schema Hardening (Phase 1)

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update
this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/2026-06-24-1957-index-schema-hardening/`
      with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — Prisma indexes

- [x] Add `@@index([repoId, filePath])` and `@@index([repoId, name])`
      to `Symbol`.
- [x] Add `@@index([repoId, toId, kind])`, `@@index([repoId, toId])`,
      `@@index([repoId, fromId])` to `Edge`.
- [x] Add `@@index([prId, reviewRunId])` to `ReviewFinding`.
- [x] Add `@@index([repoId, status, completedAt])` to `ReviewRun`.
- [x] `npm run lint` clean.
- [x] Applied to prod via `bash scripts/db-push-direct.sh`.

## Phase 3 — Embedding dimension guard

- [x] Add `EMBEDDING_DIM = 1536` constant to `embeddingService.ts`.
- [x] In `generateEmbedding`, check `vec.length !== EMBEDDING_DIM`.
      On mismatch: log warning naming the provider + dim, return `[]`.
- [x] Verified callers handle `[]` — `indexOrchestrator.ts:384` skips
      the embedding write, summary still persists.
- [x] Does NOT trip the circuit breaker on dim mismatch (config issue,
      not provider outage) — verified by test.
- [x] `npm run lint` clean.

## Phase 4 — HNSW pgvector index script

- [x] Create `scripts/create-embedding-hnsw-index.sh` mirroring
      `scripts/db-push-direct.sh`.
- [x] SQL: `CREATE INDEX IF NOT EXISTS symbols_embedding_hnsw_idx ON
      "symbols" USING hnsw ("embedding" vector_cosine_ops) WHERE
      "embedding" IS NOT NULL;`.
- [x] `chmod +x scripts/create-embedding-hnsw-index.sh`.
- [x] Applied to prod via `bash scripts/create-embedding-hnsw-index.sh`.

## Phase 5 — Tests + verification

- [x] Write `tests/embeddingGuard.test.ts` — 5 cases (1536 passes, 1024
      rejected + warns, dim mismatch doesn't trip breaker, thrown error
      trips breaker, empty input short-circuits).
- [x] `npm run lint` clean.
- [x] `npm test` — 77 passing (was 72; +5 new).
- [x] `npm run build` succeeds.
- [x] `bash scripts/db-push-direct.sh` — applies the four new indexes.
- [x] `bash scripts/create-embedding-hnsw-index.sh` — applies HNSW.
- [ ] Manual: trigger a re-index of any repo. Watch logs for either
      the happy path or the new dimension-mismatch warning.
