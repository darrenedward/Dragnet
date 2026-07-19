# Dragnet

Self-hosted, multi-tenant code review platform. The Greptile-tier review quality (full-codebase indexing + agentic review loop) without pushing source code to a third-party SaaS.

**Status:** MVP in progress. Dragnet is open source and community contributions are welcome. See [`roadmap.md`](./roadmap.md) for current priorities and [`prd.md`](./prd.md) for the full product spec.

Dragnet is being developed with AI assistance and is intentionally transparent about its current limitations. Contributions from experienced developers, security researchers, testers, designers, and documentation writers are welcome.

---

## What it does

- Watches one or more local git repositories
- Indexes the whole codebase (tree-sitter → call graph → summaries → vector embeddings)
  - **v1:** TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`) via `tree-sitter-typescript`. Other languages are walked but contribute zero symbols until their grammar spec lands — honest partial indexing, not a regex fallback. Adding Python/Go/Ruby/etc. is a small additive spec per language (pattern proven by the TS/JS spec).
- On PR scan, retrieves codebase context beyond the diff and runs an LLM-driven agentic review
- Produces structured findings backed by evidence chains (every finding cites real code)
- Runs entirely inside your infrastructure — source code never leaves your network

---

## Stack

- **Framework:** Next.js 16 (App Router, Turbopack, Route Handlers)
- **Language:** TypeScript 5.8, React 19
- **Database:** Postgres (Supabase by default) via Prisma 7.8 + `@prisma/adapter-pg`
- **Styling:** Tailwind CSS 4
- **AI:** OpenAI-compatible endpoints (OpenRouter by default) via `openai` SDK — works with OpenRouter, Ollama, LM Studio, and any other OpenAI-compatible server
- **Auth:** Better Auth (planned — Phase 2)

---

## Quick start

**Prerequisites:** Node.js 20+, a Postgres database (Supabase or local).

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment.** Copy `.env.example` to `.env.local` and fill in real values:
   ```bash
   cp .env.example .env.local
   ```
   Required: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Configure LLM providers at runtime from the **LLM Settings** tab (writes to `.dragnet/llm-presets.json`, mode 0600; changes take effect on the next request — no restart). A primary and optional fallback provider can be configured for each of chat and embedding; if both fail, the review returns empty findings with an actionable banner (never fabricated output).

3. **Generate the Prisma client and push the schema:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

4. **Run the dev server:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3300.

The in-app **DB Config** tab lets you re-test and re-save the database connection without editing `.env.local` by hand. The **LLM Settings** tab lets you point Dragnet at any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio), browse the live model catalog, and configure a **primary + optional fallback** provider for each role (chat + embedding). When the primary fails, the fallback is tried automatically — if both fail, reviews return empty findings + null rating with an actionable banner, and embeddings trip a session circuit breaker to avoid log spam.

---

## Setup

Each developer configures their local environment with two environment variables so the CLI and git hooks know where to send reviews and how to authenticate.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DRAGNET_URL` | Dragnet server address | `http://localhost:3300` |
| `DRAGNET_REPO_KEY` | Per-repo, per-user API key (generate from UI) | _(required)_ |

### Configuration

Add these to your shell profile (`.bashrc`, `.zshrc`, etc.) or create a `.env` file in your repo root:

```bash
# .env (or .env.local)
DRAGNET_URL=http://localhost:3300
DRAGNET_REPO_KEY=dr_your_key_here
```

**Generating an API key:**
1. Open the Dragnet dashboard at `http://localhost:3300`
2. Navigate to **Settings → API Keys**
3. Click **Generate key**
4. Copy the key and add it to your `.env` file

**Note:** `~/.dragnet/` is used for server-side artifacts (provider health, checkpoints, scan reports). Client configuration uses `.env` files only. Repo-specific `.dragnet/` directories (under the repo root) are also server-side only — they hold provider health state, checkpoints, and scan reports for that repo.

---

## Scripts

| Script             | Does                                          |
|--------------------|-----------------------------------------------|
| `npm run dev`      | Next.js dev server (Turbopack)                |
| `npm run build`    | Production build                              |
| `npm run start`    | Run the production server                     |
| `npm run lint`     | `tsc --noEmit` type check                     |
| `npm test`         | Vitest one-shot test run                      |
| `npm run test:watch` | Vitest in watch mode                        |
| `npm run clean`    | `rm -rf .next`                                |

---

## Project layout

```
prisma/schema.prisma       Database schema
src/app/api/               Route Handlers (one folder per resource)
src/app/page.tsx           Dashboard entry — mounts src/App.tsx
src/components/            Extracted UI (sidebar, views, modals)
src/lib/                   Shared helpers (prisma singleton, dbConfig, types)
src/services/              Domain services (indexing, embedding)
reviewService.ts           Review engine (currently a stub — replaced in Phase 1)
tests/                     Vitest specs
prd.md                     Product spec
roadmap.md                 Development roadmap with MVP-first phasing
CLAUDE.md                  Codebase conventions (read this before editing)
```

---

## Before contributing

Read [`CLAUDE.md`](./CLAUDE.md) — it covers the non-obvious conventions: Prisma singleton pattern, Next 16 Promise-based params, the pg 8.21 SSL workaround, and the 500-line file-size rule.

Please also read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request. Security vulnerabilities should be reported privately using the process in [`SECURITY.md`](./SECURITY.md).

**What never gets committed:**
- `.env.local` and any `.env*` except `.env.example` (placeholders only)
- `src/generated/prisma/` (Prisma client output)
- `.next/` (build artifacts)

---

## License

Dragnet is licensed under the [GNU Affero General Public License v3.0](./LICENSE).

You may use, study, modify, self-host, and share Dragnet under the terms of that license. Commercial use is allowed; paid hosting, support, and consulting are welcome ways to sustain the project. Contributions are credited in the project history and documentation.

Copyright © 2026 Darren Edward House of Jones.
