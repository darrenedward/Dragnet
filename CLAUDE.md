# GrepLoop

Self-hosted multi-tenant code review platform (Greptile competitor).
See `prd.md` for the full product spec.

## Stack

- **Framework:** Next.js 16 (App Router, Turbopack, Route Handlers)
- **Language:** TypeScript 5.8, React 19
- **Database:** Postgres on Supabase, accessed via Prisma 7.8 + `@prisma/adapter-pg`
- **Styling:** Tailwind CSS 4
- **Auth:** Better Auth (planned — multi-tenant via organization plugin)
- **AI:** OpenAI-compatible endpoints (OpenRouter by default) via `openai` SDK — pick chat + embedding models at runtime from the "LLM Settings" tab

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
- The OpenAI client is a **lazy singleton** at `src/lib/llmClient.ts` with a
  `globalThis` guard (mirrors `prisma.ts`). Always go through `getLlmClient()`,
  `getChatModel()`, `getEmbeddingModel()`, `getLlmEndpoint()` — never
  instantiate `OpenAI` at module load (breaks `next build` on empty env).

## Scripts

- `npm run dev` — Next.js dev server (Turbopack)
- `npm run build` — production build
- `npm run start` — production server
- `npm run lint` — `tsc --noEmit`
- `npm run clean` — `rm -rf .next`

## Database

`DATABASE_URL` in `.env.local` (gitignored). Schema in `prisma/schema.prisma`.
After schema changes, run `npx prisma db push` (dev) or create a migration.

## What NOT to commit

`.env*` is gitignored except `.env.example`, which must contain placeholders
only — never real credentials.
