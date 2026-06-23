# GrepLoop

Self-hosted multi-tenant code review platform (Greptile competitor).
See `prd.md` for the full product spec.

## Stack

- **Framework:** Next.js 16 (App Router, Turbopack, Route Handlers)
- **Language:** TypeScript 5.8, React 19
- **Database:** Postgres on Supabase, accessed via Prisma 7.8 + `@prisma/adapter-pg`
- **Styling:** Tailwind CSS 4
- **Auth:** Better Auth (planned — multi-tenant via organization plugin)
- **AI:** OpenAI-compatible endpoints (OpenRouter, Ollama, LM Studio) via `openai` SDK. Multiple provider presets stored in `.greploop/llm-presets.json` — pick one for chat and one for embedding independently (can be the same or different). Configure from the "LLM Settings" tab.

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
- LLM presets live in `.greploop/llm-presets.json` (gitignored, mode 0600).
  Source of truth is `src/lib/llmPresets.ts`. The old `.env.local` LLM_*
  vars auto-migrate into one preset on first read; new code reads from the
  presets file, not env vars.

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

The pre-push hook at `scripts/hooks/pre-push` blocks pushes that fail GrepLoop AI review (rating < 4/5). Installed via `npm run install-hooks` or `npm run greploop install-hooks`. Bypass with `git push --no-verify`.

The hook calls `POST /api/hooks/prepush` which triggers `runPrScan()` and returns a pass/fail verdict.

Requires `GREPLOOP_API_KEY` env var (generate from UI sidebar → LLM Settings → API Keys). Set `GREPLOOP_URL` to override `http://localhost:3300`.

## API keys

All authenticated endpoints (`/api/mcp/*`, `/api/hooks/prepush`) require an API key via the `Authorization: Bearer <key>` header. Keys are generated from the UI sidebar → LLM Settings → "API Keys" tab. New keys use the `gl_` prefix; legacy `gl_mcp_` keys continue to authenticate. Keys are hashed (SHA-256) at rest and can be revoked individually. The `scripts/greploop.mjs` CLI and `scripts/hooks/pre-push` hook read `GREPLOOP_API_KEY` from the environment.

## Agent skill

One skill ships with the repo:

- **`skills/gloop/SKILL.md`** — `/gloop` command family. Reviews PRs through the GrepLoop engine and reports findings with confidence scores. Rating 1-5; 4-5 is production-grade.
  - `/gloop` — list PRs for the current repo with ratings
  - `/gloop <number>` — review a specific PR
  - `/gloop status <number>` — show existing review results without re-scanning
  - `/gloop fix <number>` — auto-fix loop: review → fix → re-review until 4/5
  - `/gloop fix <number> --once` — single-pass fix, no loop

Install to your user skills dir: `cp -r skills/gloop ~/.claude/skills/`. Remove any prior `~/.claude/skills/bughunter` and `~/.claude/skills/bugfixer` first — those are the old names and are no longer shipped.

## Database

`DATABASE_URL` in `.env.local` (gitignored). Schema in `prisma/schema.prisma`.
After schema changes, run `npx prisma db push` (dev) or create a migration.

## What NOT to commit

`.env*` is gitignored except `.env.example`, which must contain placeholders
only — never real credentials. `.greploop/` is also gitignored — it holds
`.greploop/llm-presets.json` which contains API keys.
