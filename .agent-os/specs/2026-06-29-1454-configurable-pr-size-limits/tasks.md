# Tasks — Configurable PR-size Limits

Update status as work progresses. Mark each `[x]` only when the work is actually done.

## Step 0 — Decisions (resolved by implementation)

- [x] 0.1 Tail-skip behavior: **drop** (chosen per plan recommendation; implemented in Step 3).
- [x] 0.2 Defaults: **match current constants** (chosen per plan recommendation; implemented throughout).
- [x] 0.3 UI placement: **new "Review Limits" tab** (chosen per plan recommendation; implemented in Step 5).

## Step 1 — Config service

- [x] 1.1 Create `src/lib/prSizeConfig.ts` with `ReviewLimits` type, `readLimits()` (cached via `globalThis`), `saveLimits(next)` (atomic write + chmod 0600), `clearLimitsCache()`.
- [x] 1.2 Default values match current constants. No first-read seed — file appears when the user first saves via the UI (matches `llmPresets` pattern).
- [x] 1.3 Add `tests/prSizeConfig.test.ts` — round-trip save/read, default-on-missing-file, cache invalidation on save. 8 tests pass.

## Step 2 — Wire through to chunker + manifest

- [x] 2.1 `manifest.ts` `assertTierValues` accepts optional `TierThresholds`; constants stay as defaults. `buildDiffManifest` and `assertTier` thread through.
- [x] 2.2 `chunker.ts` `chunkDiff` + `verifyChunkPlan` accept optional `ChunkOptions` (`chunkLineCap`, `minUsefulChunkLines`); constants stay as defaults.
- [x] 2.3 Production wire-through: orchestrator + 4 pre-flight callers (`scan`, `prcheck`, `prepush`, `command`) now `readLimits()` once and pass values through. Existing call sites that omit the new optional param behave identically to before.
- [x] 2.4 `tests/chunker.test.ts` — added "honors ChunkOptions overrides" suite (bigger cap → fewer chunks, smaller cap → more chunks, verifier enforces overridden cap).
- [x] 2.5 `tests/largePrMode/manifest.test.ts` — added TierThresholds override tests (line + file count).
- [x] 2.6 All 37 chunker/manifest/config tests green; `npm run lint` clean.

## Step 3 — Tail-skip (only if Step 0.1 chose "drop") — chose drop

- [x] 3.1 In `orchestrator.ts:runLargePrReview`, after `buildDiffManifest` and before `chunkDiff`, `applyTailSkip(manifest, limits.maxFilesPerReview)` keeps the largest N code files and drops the rest. Non-code files (docs, lockfiles, generated, vendor) never compete for the cap.
- [x] 3.2 `composeTailSkipWarning(skipped, cap)` produces `"${skippedCount} code files not reviewed (limit ${cap}): ${fileList}"` (truncated to first 8 + "(+N more)"). Appended to the run's `effectiveWarning` with `·` separator.
- [x] 3.3 Warning flows through `logRun(..., "warn")` so it's queryable in `review_logs`.
- [x] 3.4 `tests/largePrMode/tailSkip.test.ts` — 6 tests: no-op when cap=0, no-op when count≤cap, 200-file × cap=100 keeps the 100 largest + drops the 100 smallest, re-derives counters, preserves non-code files, deterministic alphabetical tie-break.

## Step 4 — API

- [x] 4.1 New route `src/app/api/llm/review-limits/route.ts` — GET returns `{ ok, limits, defaults }`, PUT validates + saves. Session-only auth via `requireSession` (matches `/api/llm/presets/route.ts`).
- [x] 4.2 Validator extracted into `src/lib/reviewLimitsValidation.ts` so it can be tested in isolation. Bounds per plan §4.4. Rejects oversized ≤ normal, oversized files ≤ normal files, cap ≤ min-useful.
- [x] 4.3 Route calls `clearLimitsCache()` after save so next scan picks up new values without restart.
- [x] 4.4 `tests/reviewLimitsRoute.test.ts` — 10 tests covering bounds, relational checks, fractional inputs (floored), maxFilesPerReview no-mans-land (1–19), and non-numeric rejection.

## Step 5 — UI

- [x] 5.1 New "Review Limits" tab (emerald accent) added to LlmConfigView alongside Chat / Embedding / API Keys.
- [x] 5.2 `src/components/views/llm-config/ReviewLimitsPanel.tsx` form: 7 number inputs grouped into Chunking / PR-tier thresholds / Tail-skip, plus Save + Reset to defaults.
- [x] 5.3 Client-side validation mirrors server bounds (chunkCap > min-useful, oversized > normal, maxFilesPerReview is 0 or 20–500).
- [x] 5.4 Save calls `PUT /api/llm/review-limits`, shows success/error banner inline. Reset to defaults is one click.
- [x] 5.5 `npm run build` clean; full suite 145/145 green.

## Step 6 — Export Markdown to `.dragnet/`

- [x] 6.1 Extracted markdown-builder into `src/lib/exportReviewMarkdown.ts`. Takes repo + PR + run + files + findings, returns string. Used by both code paths so output stays byte-identical.
- [x] 6.2 New route `POST /api/prs/[prId]/runs/[runId]/export-markdown`. Body `{ format: "file" | "download" }`. File path: `.dragnet/reviews/<prSlug>/<runId>.md` with `prSlug = sanitizeBranchSlug(sourceBranch)`.
- [x] 6.3 Atomic write (.tmp → rename → mode 0600). Repo + PR + findings pulled from Prisma (no more client-side reconstruction).
- [x] 6.4 UI: replaced single "Export MD Card" button with primary "Save to Project" (Save icon) + secondary "Download" (Download icon). Status pill appears for 6s after either action: success shows `Saved to .dragnet/reviews/<slug>/<runId>.md`, failure shows the error message.
- [x] 6.5 `tests/exportReviewMarkdown.test.ts` — 10 tests covering slug rules (`feat/skills-bulk` → `feat-skills-bulk`, `FEAT_Foo!Bar` → `feat_foobar` per the documented rules), system-details metadata, file listing, numbered findings, perfect-pass celebration, and optional-field omission.

## Step 7 — Per-preset iteration cap

- [x] 7.1 Add optional `maxIterations?: number` field to `Preset` interface in `src/lib/llmPresets.ts`. Default 16 when absent (back-compat for existing JSON file).
- [x] 7.2 In `reviewService.ts`, find the loop bound (grep `iteration`) and pull from active chat preset instead of constant. Constant becomes the fallback when field is missing.
- [x] 7.3 UI in LLM Settings preset editor: add `Max iterations` number input per preset, bounds 4–32.
- [x] 7.4 Suggested defaults wired for current presets: NVIDIA=10, GPT-5=8, Minimax=16 (unchanged), Z.ai=16, OpenRouter=16, CommandCode=16, LM Studio=16.
- [x] 7.5 Test `tests/llmPresets.test.ts` — preset with `maxIterations` round-trips; preset without loads as 16.
- [x] 7.6 Test `tests/reviewService.test.ts` — loop bound comes from preset (mock preset, vary `maxIterations`, count iterations).

## Step 8 — Ship

- [x] 8.1 `npm run lint` (tsc --noEmit) passes.
- [x] 8.2 `npm run build` passes. (Caught + fixed a client-bundle regression: `shared.ts` was importing value constants from `llmPresets.ts`, dragging `node:fs/promises` into a `"use client"` component. Inlined the constants in `shared.ts` with a keep-in-sync note. Commit `1b8fd54`.)
- [x] 8.3 `npx vitest run` — full suite green (172/172).
- [ ] 8.4 Manual: re-scan DevWorld skills-bulk with `chunkLineCap=1500`, verify chunk count drops from 6 to ~3. Keep scan rating within ±1 of previous. *(Manual — run at next DevWorld session)*
- [ ] 8.5 Manual: re-scan with NVIDIA primary + `maxIterations=10`, verify iteration count ≤ 10 per chunk. *(Manual — run at next DevWorld session)*
- [ ] 8.6 Manual: Export Markdown from a completed scan, verify file appears at `.dragnet/reviews/<slug>/<runId>.md` and content matches the previous browser-download output. *(Manual — run at next DevWorld session)*
- [x] 8.7 Committed to `main` (dc400d6, 7e92d34, 4a4f3a4, 048cbe6, 5034c17, 484104f, 31259d0, 1b8fd54). Awaiting user go-ahead before opening PRs.

## Step 9 — Tracked as GitHub issue

- [x] 9.1 Created as [issue #40](https://github.com/darrenedwardhouseofjones/Dragnet/issues/40) with `ready-for-agent` label.

## Blockers / open questions

- Step 0 decisions block Step 1–5 implementation. Resolve before starting.
- If tail-skip "defer" wins (Step 0.1 = B), Step 3 expands materially: need a queue, a follow-up orchestrator path, and UI to show deferred files. Out of scope for v1 if "drop" wins.
- Step 7 needs the user to confirm the per-preset default values (§9.6 in plan.md) before wiring — they're starting suggestions, not decisions.
