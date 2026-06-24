# GrepLoop

Self-hosted multi-tenant code review platform (Greptile competitor).
See `prd.md` for the full product spec.

## Stack

- **Framework:** Next.js 16 (App Router, Turbopack, Route Handlers)
- **Language:** TypeScript 5.8, React 19
- **Database:** Postgres on Supabase, accessed via Prisma 7.8 + `@prisma/adapter-pg`
- **Styling:** Tailwind CSS 4
- **Auth:** Better Auth (planned — multi-tenant via organization plugin)
- **AI:** OpenAI-compatible endpoints (OpenRouter, Ollama, LM Studio) via `openai` SDK. Multiple provider presets stored in `.greploop/llm-presets.json` — pick a **primary + optional fallback** for each role (chat and embedding) independently. If the primary fails, the fallback is tried automatically; if both fail, reviews return empty findings + null rating + actionable banner (never templated/hallucinated output), and embeddings trip a session circuit breaker. Configure from the "LLM Settings" tab.

## Conventions

- All API routes are Next.js Route Handlers under `src/app/api/`. There is no
  Express server. URLs are relative (`/api/...`) and the frontend's fetches
  don't need a host prefix.
- The Prisma client is a singleton at `src/lib/prisma.ts` with a `globalThis`
  guard. Import from there — never instantiate `PrismaClient` directly.
- Dynamic Route Handler params are Promises in Next 16: `const { id } = await params;`
- File rule: keep every file under 500 lines. Split big files into a directory
  of focused modules (e.g. `users/manage/personalDetails.tsx`).
- The `src/lib/dbConfig.ts` helper handles all connection-string parsing,
  testing, and `.env.local` persistence for the in-app DB config UI.
- Supabase connections need `ssl: { rejectUnauthorized: false }` because pg
  8.21 changed `sslmode=require` to mean `verify-full` (strict). The helpers
  in `src/lib/dbConfig.ts` and `src/lib/prisma.ts` both handle this — don't
  strip the workaround.
- `reviewService.ts` and `src/services/indexingService.ts` live where they are
  because of relative-import depth. Don't relocate without checking require()
  paths from `reviewService.ts`.
- The OpenAI clients are **lazy dual singletons** at `src/lib/llmClient.ts`
  with `globalThis` guards (mirrors `prisma.ts`). Always go through
  `getChatClient()` / `getChatModel()` for the chat role (drives
  `reviewService.ts` and `embeddingService.ts:generateSummary`) and
  `getEmbeddingClient()` / `getEmbeddingModel()` for the embedding role
  (drives `embeddingService.ts:generateEmbedding`). The two roles can point
  at different presets/endpoints. Never instantiate `OpenAI` at module load
  (breaks `next build` on empty env).
- Multi-provider fallback: `getChatChain()` / `getEmbeddingChain()` return
  ordered arrays of `{client, model, name}` — primary first, fallback
  second. `reviewService.ts` and `embeddingService.ts` iterate the chain
  and try each provider until one succeeds. If both fail, reviews persist
  no findings + null rating + actionable `systemWarn`; embeddings trip a
  session-scoped `embeddingCircuitOpen` flag and return `[]` silently to
  avoid log spam.
- LLM presets live in `.greploop/llm-presets.json` (gitignored, mode 0600).
  Source of truth is `src/lib/llmPresets.ts`. The old `.env.local` LLM_*
  vars auto-migrate into one preset on first read; new code reads from the
  presets file, not env vars.
- The tree-sitter parser + per-extension `Language` are **lazy singletons**
  at `src/lib/treeSitter.ts` with a `globalThis.__treeSitterCache` guard
  (mirrors `prisma.ts` and `llmClient.ts`). Always go through `getParser()`
  / `getLanguage(ext)` / `isSupportedFilePath(filePath)`. v1 ships grammars
  for `.ts`, `.tsx`, `.js`, `.jsx` only — other extensions log a
  `[indexing] skipping <file>: no grammar yet` warning and contribute zero
  symbols. Never call `Parser.init()` or `Language.load()` at module load
  (breaks `next build`). `.wasm` files are copied from `node_modules/` into
  `public/grammars/` by `scripts/copy-grammars.mjs` on `postinstall`.
- Indexing lives in `src/services/indexing/` — split per the 500-line rule:
  `tsParser.ts` (tree-sitter extraction), `graphBuilder.ts` (rawCalls →
  edges), `incrementalUpdater.ts` (file-hash diff), `indexOrchestrator.ts`
  (`IndexingService` class + background enrichment), `types.ts`, and
  `index.ts` (barrel). The legacy `src/services/indexingService.ts` is now
  a one-line re-export shim for back-compat.

## Scripts

- `npm run dev` — Next.js dev server (Turbopack)
- `npm run build` — production build
- `npm run start` — production server
- `npm run lint` — `tsc --noEmit`
- `npm run clean` — `rm -rf .next`
- `npm run greploop` — `node scripts/greploop.mjs` (CLI companion: `npm run greploop install-hooks`, `npm run greploop review <branch>`)
- `npm run install-hooks` — installs the pre-push git hook into `.git/hooks/pre-push`
- `npm run uninstall-hooks` — removes the pre-push git hook

## Pre-push hook

The pre-push hook at `scripts/hooks/pre-push` blocks pushes that fail GrepLoop AI review (rating < 8/10). Installed via `npm run install-hooks` or `npm run greploop install-hooks`. Bypass with `git push --no-verify`.

The hook calls `POST /api/hooks/prepush` which triggers `runPrScan()` and returns a pass/fail verdict.

Requires `GREPLOOP_API_KEY` env var (generate from UI sidebar → LLM Settings → API Keys). Set `GREPLOOP_URL` to override `http://localhost:3300`.

## API keys

All authenticated endpoints (`/api/command`, `/api/prcheck`, `/api/prcomments`, `/api/hooks/prepush`) require an API key via the `Authorization: Bearer <key>` header. Keys are generated from the UI sidebar → LLM Settings → "API Keys" tab. New keys use the `gl_` prefix; legacy `gl_mcp_` keys continue to authenticate. Keys are hashed (SHA-256) at rest and can be revoked individually. The `scripts/greploop.mjs` CLI and `scripts/hooks/pre-push` hook read `GREPLOOP_API_KEY` from the environment.

## Agent skill

One skill ships with the repo:

- **`skills/gloop/SKILL.md`** — `/gloop` command family. Reviews PRs through the GrepLoop engine and reports findings with confidence scores. Rating 1-10; 8+ is production-grade.
  - `/gloop` — list PRs for the current repo with ratings
  - `/gloop <number>` — review a specific PR
  - `/gloop status <number>` — show existing review results without re-scanning
  - `/gloop fix <number>` — auto-fix loop: review → fix → re-review until 8/10
  - `/gloop fix <number> --once` — single-pass fix, no loop

Install to your user skills dir: `cp -r skills/gloop ~/.claude/skills/`. Remove any prior `~/.claude/skills/bughunter` and `~/.claude/skills/bugfixer` first — those are the old names and are no longer shipped.

## Database

`DATABASE_URL` in `.env.local` (gitignored). Schema in `prisma/schema.prisma`.
After schema changes, run `npx prisma db push` (dev) or create a migration.

## What NOT to commit

`.env*` is gitignored except `.env.example`, which must contain placeholders
only — never real credentials. `.greploop/` is also gitignored — it holds
`.greploop/llm-presets.json` which contains API keys.

## Troubleshooting

**Symptom:** `/tmp/greploop-dev.log` shows `Failed to generate embedding: 500 error starting llama-server: llama-server binary not found` every few seconds.

**Cause:** An Ollama package upgrade left the backend binary missing on this machine. Every embedding call fails, the indexing service keeps retrying, no vectors get written. `searchCodebase` / `findSimilar` tools return empty results — the LLM has diff-only context.

**Fix (any of):**
1. Reinstall Ollama: `curl -fsSL https://ollama.com/install.sh | sh` then `ollama pull mxbai-embed-large`. Restart the dev server.
2. Configure a cloud embedding preset (OpenAI direct, Voyage AI, Cohere, etc.) as either primary or fallback in LLM Settings. The circuit breaker auto-resets on the next process restart.

**Why only one log line per session:** the embedding service has a module-level circuit breaker (`embeddingCircuitOpen`). Once all providers fail, subsequent calls return `[]` instantly and a single `console.error` is emitted with the remediation hint. Restart the dev server after fixing the underlying issue.

**Symptom:** PR review returns empty findings with a banner like "All chat providers failed (last error: …)".

**Cause:** Every provider in the chat chain threw (network down, key revoked, model retired, etc.). The previous procedural fallback that templated fake findings was removed — empty + null + actionable banner is the honest failure mode.

**Fix:** check the LLM Settings tab — both primary and fallback chat providers need valid endpoints + keys. Use "Fetch Models" on each preset to verify connectivity.

**Symptom:** PR review returns empty findings with a banner like "Model X ended the agentic loop without calling submitReview".

**Cause:** the model ran but never produced a `submitReview` tool call. Usually means the model doesn't support function calling, or the model is too small to follow the agentic loop. Tail `/tmp/greploop-dev.log` for `[review] iteration N/8` + `[review] tool …` + `[review] loop exited without submitReview` lines to confirm.

**Fix:** switch to a model that supports function calling (most OpenRouter chat models do; some local Ollama models don't).

**Symptom:** Indexing completes but `Symbol` / `Edge` rows are empty, and `/tmp/greploop-dev.log` shows `[indexing] skipping <file>: no grammar yet (v1 supports .ts/.tsx/.js/.jsx)` for every file.

**Cause:** `npm install` ran without the `postinstall` hook (or the hook failed silently), so `public/grammars/*.wasm` is missing. `treeSitter.ts` falls back to `node_modules/tree-sitter-typescript/` but in some bundler/CWD configurations that path isn't reachable at parse time.

**Fix:** run `npm run postinstall` (or `npm run copy-grammars`) and confirm `ls public/grammars/*.wasm` shows `tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm` + `tree-sitter-javascript.wasm` + `tree-sitter-jsx.wasm`. Restart the dev server.

**Symptom:** Indexing completes for `.ts`/`.tsx` files but skips `.py`, `.go`, `.rs`, etc. with the `no grammar yet` warning.

**Cause:** v1 only ships TS/JS grammars. Other languages are intentionally logged-and-skipped (honest partial indexing, not a regex fallback that would produce wrong line ranges).

**Fix:** nothing to fix — this is expected. Follow-on specs add per-language grammars (`tree-sitter-python`, `tree-sitter-go`, etc.). The pattern is documented in `.agent-os/specs/2026-06-24-1645-tree-sitter-indexer-ts-js/plan.md`.
