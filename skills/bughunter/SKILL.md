---
name: bughunter
description: Review your code changes through the GrepLoop AI review engine. Use when the user asks to review their branch, check their code for bugs, run a code review, fix issues found by review, or invokes /bughunter.
user-invocable: true
---

# BugHunter

BugHunter is a self-hosted AI code review engine built on GrepLoop. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems — producing findings backed by evidence chains.

You drive it through the GrepLoop HTTP API. The review endpoint is synchronous — it blocks until the review completes (typically 30-120s for a full agentic loop).

## How `/bughunter` finds the right PR

- **`/bughunter`** (no args) — Lists all PRs for the current repo with their ratings. User picks one.
- **`/bughunter 42`** — Reviews PR #42. If it passes (4-5), the user merges. If not, they run `/bugfixer 42`.
- The skill detects the current repo from `git remote get-url origin` and resolves it to a GrepLoop `repoId`.

So the workflow is: `/bughunter` → see PR list → `/bughunter 2` → see it's 2/5 → `/bugfixer 2` → auto-fix loop.

All API endpoints require authentication. Pass your API key in the `Authorization` header:
```
Authorization: Bearer gl_mcp_<your_key>
```
Generate a key from the GrepLoop UI → Settings → MCP API Keys. If no key is configured, tell the user to create one.

## Two skills

Two separate skills, one for each job:

### `/bughunter` — Hunt (review & report)

- **`/bughunter`** — List all PRs for the current repo with ratings. Lets the user pick one.
- **`/bughunter <number>`** or **`/bughunter review <number>`** — Review a specific PR. Returns rating 1-5 + findings with confidence scores.
- **`/bughunter status <number>`** — Show existing review results without a new scan.

### `/bugfixer` — Fix (auto-fix loop)

- **`/bugfixer`** — Review → fix → re-review until rating >= 4/5, then report pass.
- **`/bugfixer once`** — Apply fixes for all findings above `minConfidence` in one pass (no loop).

The fixer calls `/bughunter` to get findings, applies each fix, commits (`fix: address review findings`), then re-reviews. It loops until rating >= 4/5 or the user hits interrupt.

## Rating scale

The GrepLoop review returns a rating from 1 to 5:

- **4–5** — Production grade, safe to merge
- **1–3** — Needs fixes. Loop with `/bugfixer` until it passes.

## What the GrepLoop API returns

`POST /api/mcp/command` with command `/prcheck <number>` or `{ repoId, branch }`:

```
{
  "status": "Success",
  "rating": "4/5",
  "productionGrade": "YES" | "NO",
  "summary": "...",
  "findingsCount": 3,
  "findings": [
    "[Security | blocker] src/auth.ts:42 - Unvalidated redirect...",
    "[Correctness | warning] src/api.ts:88 - Missing error handling..."
  ]
}
```

`POST /api/mcp/command` with command `/prcomments <number>` returns the persisted findings:

```
{
  "status": "Success",
  "comments": [
    { "category": "Security", "severity": "blocker", "filename": "src/auth.ts",
      "line": 42, "comment": "...", "fixSuggestion": "...", "confidence": 0.92 }
  ]
}
```

`POST /api/mcp/command` with command `/prlist` and `{ repoId }` lists all PRs:

```
{
  "status": "Success",
  "pullRequests": [
    { "number": "1", "title": "Add auth", "branch": "feature/auth",
      "rating": "4/5", "status": "Completed" },
    { "number": "2", "title": "Fix bug", "branch": "feature/fix",
      "rating": "2/5", "status": "Completed" }
  ]
}
```

A non-200 response means the repo hasn't been indexed yet or the PR wasn't found. Surface the error message to the user with instructions.

## Auto-fix protocol (`/bugfixer`)

When fixing findings, follow this loop:

1. **Call review** — `POST /api/mcp/command` with `/prcheck` (or pass `repoId`+`branch`)
2. **Check rating** — If >= 4/5, report pass and exit
3. **Present findings** — Show findings filtered by confidence (>= 0.5). Skip low-confidence noise.
4. **Apply fixes** — For each finding, read the file at the specified line, understand context, apply the `diffSuggestion` code change.
5. **Commit** — `fix: address review findings`
6. **Re-review** — Call `/prcheck` again
7. **Loop** — If still < 4/5, repeat. If 3+ iterations with no rating improvement, warn the user.
8. **Report** — Final verdict: passed (4-5) or what remains

## Installing the pre-push hook

Run `npm run greploop install-hooks` (or `npm run install-hooks`) to install the pre-push hook. This copies `scripts/hooks/pre-push` into `.git/hooks/pre-push`. The hook automatically blocks pushes that fail review (rating < 4/5), acting as a safety net even when you don't explicitly run `/bughunter`.

## Preconditions

Before running any review:
- The GrepLoop dev server must be running
- Verify with `curl -s http://localhost:3300/api/repos | jq length` — if the response is empty or fails, tell the user to start the server with `npm run dev`.
- The current directory must be inside a git repository with a non-default branch
- The repo must be registered in GrepLoop (visible in the sidebar)
- The repo must have been indexed (open the "Codebase AST graph" tab and run the indexer)
