# Tasks — Multi-Provider Fallback + Honest Failure

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Schema: primary + fallback presets

- [x] Extend `PresetsFile` interface in `src/lib/llmPresets.ts` with `primaryChatPresetId`, `fallbackChatPresetId`, `primaryEmbeddingPresetId`, `fallbackEmbeddingPresetId`.
- [x] Backward-compat migration in `parseFile()`: if old `activeChatPresetId` exists and `primaryChatPresetId` doesn't, copy across. Same for embedding. Trigger save on first detection.
- [x] Update `emptyState()` to include the four new fields (null for fallbacks).
- [x] Add `getFallbackChatPreset()` and `getFallbackEmbeddingPreset()` getters.
- [x] Update `listPresets()` to return all four slot ids.
- [x] Update `validatePresetsInput()` to type-check the four new fields and ensure fallback ids (when non-empty) reference existing presets.
- [x] Updated `src/app/api/llm/presets/route.ts` PUT handler to write the new shape.
- [x] `npm run lint` clean.
- [ ] Manual: load UI, confirm existing single-provider config still loads (primary slot populated, fallback empty).

## Phase 2 — Chat + embedding client chains

- [ ] Add `getChatChain(): Array<{client: OpenAI, model: string, name: string}>` in `src/lib/llmClient.ts`.
- [ ] Mirror `getEmbeddingChain()`.
- [ ] Both return primary first, fallback second (skip if fallback unset or equal to primary).
- [ ] Keep existing `getChatClient`/`getChatModel`/`getEmbeddingClient`/`getEmbeddingModel` working as primary-only shortcuts.

## Phase 3 — Review service: iterate chain, honest failure

- [ ] Change `let rating = 5;` to `let rating: number | null = null;` at `reviewService.ts:293`.
- [ ] Delete `generateRealisticFindings()` (lines 18-91).
- [ ] Delete the three call sites at lines 337, 446, 452.
- [ ] Replace the `if (!client || !chatModel)` block + try/catch with a chain iteration loop.
- [ ] Inside the loop: run the agentic loop parameterized by `client`/`model`. Break on `finalReview`. Catch per-provider errors and continue.
- [ ] After the loop: if `finalReview`, use its findings/rating. Otherwise set actionable `systemWarn` and leave findings `[]`/rating `null`.
- [ ] Manual: trigger scan on solarplanner `feature/agent-blog-api`. Confirm either real findings OR empty + systemWarn, never templated findings.

## Phase 4 — Embedding service: chain + circuit breaker

- [ ] Add module-level `let embeddingCircuitOpen = false;` in `src/services/embeddingService.ts`.
- [ ] Refactor `generateEmbedding` to loop over `getEmbeddingChain()`, try each provider, return first success.
- [ ] If all fail: trip `embeddingCircuitOpen`, log single `console.error` with friendly message, return `[]`.
- [ ] Early-return `[]` at top of `generateEmbedding` if `embeddingCircuitOpen` is true.
- [ ] Manual: tail `/tmp/greploop-dev.log` after a scan. Confirm at most one embedding error per session.

## Phase 5 — Agentic loop logging

- [ ] Log `[review] iteration ${loopCount}/8 provider=${name}` at top of each iteration.
- [ ] Log `[review] tool ${fnName} → ${resultSummary}` after each tool call (where resultSummary is "N results" or "error: ...").
- [ ] Log `[review] submitReview received: rating=${...} findings=${...}` when submitReview fires.
- [ ] Log `[review] loop exited without submitReview (iterations used: ${loopCount}, last message had tool_calls: ${!!msg.tool_calls?.length})` when finalReview stays null.

## Phase 6 — Legacy command handler: route prcheckstatus

- [ ] Add `cmdName.endsWith("prcheckstatus") || cmdName.endsWith("status")` branch in `handleLegacyCommand` before Unknown fallthrough.
- [ ] Reuse `resolvePr`, `isReviewActive`, persisted findings/rating lookups.
- [ ] Return shape: `{ status, type: "status", productionScore, findingsCount, findings }`.
- [ ] Manual: `curl -X POST localhost:3300/api/mcp/command -d '{"command":"prcheckstatus","repoId":"<id>","branch":"<branch>"}'` returns JSON, not "Unknown command".

## Phase 7 — UI: 4 pickers in LLM Settings

- [ ] Update `src/components/views/llm-config/RolePanel.tsx` (or equivalent) to render primary + fallback pickers per role.
- [ ] Fallback picker includes a "None" option.
- [ ] Wire save handler to persist `primaryChatPresetId`/`fallbackChatPresetId`/`primaryEmbeddingPresetId`/`fallbackEmbeddingPresetId`.
- [ ] Add "Test Fallback" button that runs `fetchRemoteModels` against the fallback preset.
- [ ] Manual: load `/` in browser, open LLM Settings, confirm all four pickers render and persist across reload.

## Phase 8 — Ollama fix script + docs

- [ ] Create `scripts/fix-ollama.sh` (curl install ollama + pull mxbai-embed-large).
- [ ] `chmod +x scripts/fix-ollama.sh`.
- [ ] Add "Troubleshooting" section to `CLAUDE.md` covering circuit breaker, fix script, fallback configuration.
- [ ] Note multi-provider support in `README.md` LLM Settings description.

## Final verification

- [ ] `npm run lint` clean (tsc --noEmit).
- [ ] `npm test` — existing tests still pass.
- [ ] Commit each phase individually per the user's `git add .` convention.
