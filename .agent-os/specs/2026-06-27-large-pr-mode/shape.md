# Large PR Mode — Shaping Notes

## Scope

A new orchestration layer that lets GrepLoop review PRs too large for a single agentic pass. PRs above the normal threshold are split into directory-tiered chunks, each scanned independently by the existing `runPrScan` primitive, then aggregated into a single reliability-tagged verdict.

Large PR Mode consumes the standalone PR Size Profile utility. Size Profile ships first as a warning label on all PR-bearing surfaces (`small | medium | large | oversized`), using code-line counts rather than raw diff lines. Large PR Mode then uses the same classifier/profile to decide whether to keep the existing single-pass scan or route to chunked review.

The orchestrator owns state and lifecycle (`ReviewChunk` rows, per-chunk progress, aggregation); `runPrScan` stays a single-chunk primitive. No changes to its internal logic — only an optional `reviewChunkId` parameter for log/finding attribution.

Three reliability outcomes are surfaced honestly: `complete` (all chunks succeeded), `partial` (some chunks failed/skipped, none security-sensitive), `incomplete_security_review` (a security-sensitive chunk failed → rating `null`). Partial reviews are never presented as complete.

## Decisions

1. **Orchestration around `runPrScan`, not inside it.** A new `runLargePrReview(reviewRunId)` function calls `buildDiffManifest → chunkDiff → runChunksSequentially → aggregateResults`. `runPrScan` becomes a chunk-level primitive with signature `runPrScan(prId, files, reviewRunId, reviewChunkId?)`. The orchestrator owns state; `runPrScan` owns one scan. Separation keeps both debuggable.
2. **Chunking is a priority order, not a menu.** (1) Monorepo package boundary → (2) file type within package (schema/routes/components/services/tests) → (3) 600-line size cap with recursive split. Deterministic and debuggable for v1. Tree-sitter/call-graph clustering is v2.
3. **Tier thresholds hardcoded for v1.** Normal: <800 code lines AND <40 code files. Grouped (Large PR Mode): >800 code lines OR >40 code files. Oversized: >3000 code lines OR >100 files. Oversized is **not** a hard refusal in v1; it is chunked best-effort with "split recommended" copy and may end `partial` / `incomplete_security_review`.
4. **`ReviewChunk` is a first-class DB model.** Lifecycle `pending | running | completed | failed | skipped` with `skipReason`, `rating`, `summary`, `errorMessage`, `startedAt`, `completedAt`. First-class rows are what enable idempotent retry/resume.
5. **Sequential chunk execution for v1.** Default concurrency 1. Configurable up to 3 in v1.1, not v1. Reasons: per-preset rate limits trip on parallel; sequential is debuggable; cost is linear anyway.
6. **Lock at PR level, not chunk level.** Existing `reviewLocks` semantics — a PR can't be in two Large PR Mode runs concurrently. Same-PR parallelism is v1.1+.
7. **Retry once per chunk on transient failure** (timeout, invalid JSON, network). Second failure → chunk marked `failed` permanently. The UI's "Retry failed chunks" button re-runs only `status='failed'` rows, idempotent.
8. **Aggregation is deterministic and idempotent.** Dedup findings by `(filename, line, category)`. Deterministic checks (`tsc`/`eslint`) run **once at run level**, not per chunk — otherwise tsc reports the same 12 errors N times. Re-running aggregation on the same completed chunks produces the same final rating.
9. **Cross-chunk bugs are explicitly out of scope for v1.** Caller in chunk A, callee in chunk B → bug invisible. The Large PR Mode banner states this. Cross-chunk merge pass is v1.5.
10. **Auto-route to Large PR Mode when tier = grouped or oversized.** No opt-in. Banner: *"Large PR Mode: N chunks. Note: cross-chunk bugs may be missed."* Oversized adds a persistent "split recommended" warning.
11. **Three-tier security-sensitive classification.** A chunk is security-sensitive if any file matches: (a) hardcoded global default globs (`src/app/api/auth/**`, `**/webhook*`, `prisma/schema.prisma`, etc.), (b) hardcoded keyword fallback (`**/*auth*`, `**/*crypto*`, `**/*token*`, etc. — accepts false positives, override list is v1.1), or (c) repo-configured `Repository.securitySensitivePaths` additions (seeded empty; GrepLoop's own deployment seeds tool-specific paths like `src/services/findingVerifier.ts`).
12. **Reliability verdict drives rating nullability.** `complete` → aggregated rating. `partial` → aggregated rating + visible warning. `incomplete_security_review` → rating `null`, no false green.
13. **Skipped chunks are visible, not silent.** `ReviewChunk.skipReason` is mandatory whenever status = `skipped`. Aggregation surfaces skipped chunks in the final summary with their reasons. Silent skips are as bad as silent failures.
14. **No cost estimation in v1.** Just chunk count. Per-preset cost math is v1.5.

## Context

- **Visuals:** Additive only — a "Large PR Mode" banner with chunk count, a per-chunk progress panel, a failed-chunk retry button, and a `partial`/`incomplete_security_review` badge. No mockups needed; mirrors existing `ReviewProgress` styling.
- **References:** See `references.md`. Primary patterns to mirror: `src/lib/reviewLocks.ts` (concurrency guard), `src/services/findingVerifier.ts` (per-finding post-processing), `src/lib/reviewFreshness.ts` (discriminated union + lifecycle helpers).
- **Product alignment:** Directly addresses the failure mode observed on `feature/bug-demo` (21,053-line diff, 178 files, 125 commits) where the agentic loop exhausted 16 iterations without producing a `submitReview` call. No code-review tool — commercial or self-hosted — can reason over a diff that size; this spec makes that boundary explicit and honest rather than silently degrading.

## Triggering incident

On 2026-06-27, a `/gloop fix 1 --auto` re-review of `feature/bug-demo` ran for ~11 minutes against commit `130f5bf` and **failed** — Minimax-M3 exhausted all 16 agentic-loop iterations without emitting a `submitReview` tool call, and the Z.ai Flash fallback also failed. The PR was 21,053 lines across 178 files. The prior cached 7/10 run had squeaked through on a smaller diff at `3e0c5ea`; the new commit pushed it past the model's effective context budget.

This spec prevents that class of failure by detecting oversized diffs *before* spending LLM budget, warning the user clearly, routing them through chunked review best-effort, and surfacing partial results honestly when chunks fail.

## Standards Applied

- **Discriminated-union return shape** — `assertTier(prManifest)` returns `{ ok: true; tier: "normal" } | { ok: true; tier: "grouped" } | { ok: true; tier: "oversized"; message: string }`. Mirrors `assertIndexFresh` from `src/lib/indexFreshness.ts:25-85`, but intentionally avoids hard refusal in v1.
- **500-line file rule** — orchestrator split across `runLargePrReview/` directory (`orchestrator.ts`, `manifest.ts`, `chunker.ts`, `aggregator.ts`, `securitySensitive.ts`); each file stays well under cap.
- **Lazy singletons via `getChatChain()`** — chunks reuse the existing chat chain; never instantiate OpenAI clients directly.
- **Sequential Prisma writes (no `$transaction`)** — PgBouncer/Supabase pooler caps interactive transactions at 5s; chunk row writes are sequential per established pattern.
- **Fail-open on infrastructure errors** — manifest computation, chunker, and aggregator never throw on malformed input; degrade to a sentinel and proceed.
- **Backward-compat shims** — `runPrScan`'s new `reviewChunkId?` parameter is optional; existing callers keep working without changes.
- **No silent degradation** — partial/unreliable outcomes surface in the API response and UI with explicit `reliability` field and failed-chunk list.
