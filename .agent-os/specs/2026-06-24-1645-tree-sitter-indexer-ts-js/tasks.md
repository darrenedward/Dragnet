# Tasks — Tree-sitter Indexer (TS/JS v1)

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/` with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — Install deps + grammar packaging

- [x] `npm install web-tree-sitter tree-sitter-typescript`.
- [x] Add `"postinstall": "node scripts/copy-grammars.mjs"` to `package.json`.
- [x] Create `scripts/copy-grammars.mjs` that copies all `.wasm` files from `node_modules/tree-sitter-typescript/` into `public/grammars/`.
- [x] Add `public/grammars/` to `.gitignore`.
- [x] Run `npm run postinstall` manually; verify `ls public/grammars/*.wasm` shows TS + TSX (and JS + JSX if shipped).
- [x] `npm run lint` clean.

## Phase 3 — `treeSitter.ts` lazy singleton

- [x] Create `src/lib/treeSitter.ts` exporting `getParser()`, `getLanguage(ext)`, `getLanguageByFilePath(filePath)`.
- [x] Mirror `globalThis.__treeSitterCache` guard from `llmClient.ts`.
- [x] Never call `Parser.init()` or `Language.load()` at module load.
- [x] Confirm `npm run build` doesn't break (catches WASM-at-build-time issues).
- [x] `npm run lint` clean.

## Phase 4 — Split `indexingService.ts` into `indexing/` directory

- [x] Create `src/services/indexing/types.ts` (SymbolNode, EdgeNode, ParsedFile interfaces).
- [x] Create `src/services/indexing/legacyRegexParser.ts` (temporary copy of `parseFileSymbols` + `findBlockEnd` for parity tests).
- [x] Create `src/services/indexing/graphBuilder.ts` (edge resolution from raw calls — logic from `:539-567`).
- [x] Create `src/services/indexing/incrementalUpdater.ts` (file diff logic from `:421-481`).
- [x] Create `src/services/indexing/indexOrchestrator.ts` (`IndexingService` class: `indexFolder`, `runIndex`, `isIndexing`, re-entrancy lock).
- [x] Create `src/services/indexing/index.ts` barrel re-exporting `IndexingService` (back-compat for callers).
- [x] Update callers if any import path changes (`grep -rn "indexingService" src/`).
- [x] Verify each file under 500 lines (`wc -l src/services/indexing/*.ts`).
- [x] Delete old `src/services/indexingService.ts`.
- [x] `npm run lint` clean.
- [x] `npm test` — existing tests still pass.

## Phase 5 — Tree-sitter TS/JS parser

- [x] Create `src/services/indexing/tsParser.ts` with `parseFileSymbols(repoId, filePath, content)` matching the existing return shape.
- [x] Use tree-sitter query DSL for symbol extraction (functions, arrow consts, classes, methods).
- [x] Use tree-sitter query DSL for call-site extraction (`call_expression`).
- [x] Symbol ID = `hash(repoId + filePath + kind + name + lineStart)`.
- [x] Edge kind normalized to `CALLS` everywhere.
- [x] JSX/TSX dispatched to `tree-sitter-tsx.wasm` grammar.
- [x] Audit `reviewService.ts` and all other edge-kind readers; normalize to `CALLS` in the same commit.
- [x] Anonymous/default exports get synthetic names (`default`, `anonymous-${lineStart}`).
- [x] `npm run lint` clean.

## Phase 6 — Parity tests

- [x] Create `tests/indexing/` directory.
- [x] Create fixtures: `tests/indexing/fixtures/{functions,classes,methods,jsx,imports,nested,calls}.{ts,tsx,js,jsx}`.
- [x] Create `tests/indexing/parity.test.ts`:
  - [x] Symbol count per fixture matches expected.
  - [x] Each symbol's `(lineStart, lineEnd)` correct (manual verification).
  - [x] Symbol IDs stable across two parses of identical input.
  - [x] Tree-sitter parser agrees with legacy regex parser on named functions/classes (regression guard).
- [x] Cover edge cases that broke the regex: template literals with `{`, JSX, comments containing `function`.
- [x] `npm test` — all parity tests pass + existing tests still pass.

## Phase 7 — Wire new parser + delete regex code

- [x] Replace `parseFileSymbols` call in `indexOrchestrator.ts` with `tsParser.ts` import.
- [x] Add extension gate: `.ts/.tsx/.js/.jsx` → tree-sitter; others → `[indexing] skipping {file}: no grammar yet` + contribute zero symbols.
- [x] Delete `src/services/indexing/legacyRegexParser.ts`.
- [x] Delete `findBlockEnd` if still present anywhere.
- [x] Delete the regex patterns (now dead code in legacy file).
- [x] Update class header comment (no longer "custom pattern-matching lexer").
- [x] `npm run lint` clean.
- [x] `npm test` — all tests pass.
- [x] `npm run build` — production build succeeds (1 pre-existing NFT warning from next.config.ts, unrelated).

## Phase 8 — Docs + final verification

- [x] Add `CLAUDE.md` conventions entry for `treeSitter.ts` singleton (mirror the `llmClient.ts` paragraph).
- [x] Add `CLAUDE.md` Troubleshooting: "If indexing skips all files with 'no grammar yet' — `npm run postinstall` didn't copy `.wasm`. Check `public/grammars/`."
- [x] Update `README.md` to mention TS/JS support (drop any stale "all languages" claim).
- [x] Update `prd.md:337` gap audit — mark tree-sitter item resolved.
- [x] Update `roadmap.md:84` Track 1A task #1 — mark `[x]`.
- [x] Mark all items in this `tasks.md` complete.

## Final verification

- [x] `npm run lint` clean (tsc --noEmit).
- [x] `npm test` — all tests pass (55/55 across 6 files).
- [x] `npm run build` — production build succeeds.
- [ ] Manual: start dev server, register GrepLoop's own repo, trigger indexing. Confirm `Symbol` rows have correct line ranges + `Edge` rows have `kind = "CALLS"`.
- [ ] Manual: trigger PR scan on a TS-only branch. Findings cite real line numbers.
- [x] Commit each phase individually per the user's `git add .` convention.
