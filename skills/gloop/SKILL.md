---
name: gloop
description: Review code through the GrepLoop engine. Use when the user asks to review their branch, check code for bugs, run a code review, fix issues found by review, or invokes /gloop.
user-invocable: true
---

# GrepLoop (`/gloop`)

GrepLoop is a self-hosted AI code review engine. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems.

You drive it through the GrepLoop HTTP API at `http://localhost:3300` (override via `GREPLOOP_URL`). Reviews run asynchronously — `prcheck` starts a scan and returns immediately; `prcheckstatus` polls for completion or returns cached results.

## Commands

| Command | What it does |
|---|---|
| `/gloop` | List PRs for the current repo with ratings. |
| `/gloop <n>` | Review PR #N. Cache-aware — returns existing results if diff unchanged, starts new scan otherwise. |
| `/gloop status <n>` | Show existing review for PR #N. Never triggers a new scan. |
| `/gloop fix <n>` | Auto-fix loop: review → fix → re-review until rating >= 8/10. |
| `/gloop fix <n> --once` | Single pass: fix all findings, commit, done. |
| `/gloop help` | Print this table. |

Typical workflow: `/gloop` → pick a PR → `/gloop 1` → see rating → `/gloop fix 1` until 8+/10.

## Resolving the repoId

The skill needs the GrepLoop `repoId` for the current project. It's a string like `greploop-1782121720477` (slug + timestamp).

Resolve in this order:
1. Read `.greploop/repo-id` in the current repo's root (written automatically when the repo was registered via the GrepLoop UI). Use `git rev-parse --show-toplevel` to find the repo root, then read `<root>/.greploop/repo-id`. Strip whitespace.
2. Fall back to `GREPLOOP_REPO_ID` env var if the marker file is missing (e.g. repo was registered before this feature shipped, or the directory was copied without `.greploop/`).
3. If neither yields a repoId, **stop and tell the user**: "No `.greploop/repo-id` marker found. Re-register the repo in the GrepLoop UI to write one, or set `GREPLOOP_REPO_ID` manually." Do NOT call `/api/repos/resolve` — it requires a browser session cookie and 401s against an API key.

## Auth

Every call needs `Authorization: Bearer gl_<key>` (or legacy `gl_mcp_<key>` — both work). Read it from `GREPLOOP_API_KEY`. If unset, stop and tell the user: "Set `GREPLOOP_API_KEY` — generate one from the GrepLoop UI → Settings → API Keys."

## API shape (legacy command endpoint)

All commands POST to `http://localhost:3300/api/command` with this body:
```json
{ "command": "<subcommand> <arg>", "repoId": "<repoId>" }
```

The `<arg>` is a PR `id` (preferred) or `branch` — both accepted. Numeric ordinals (`1`, `2`) are NOT accepted by this endpoint — translate them via `prlist` first (see below).

| `command` value | What it does | Returns |
|---|---|---|
| `"prlist"` | List all PRs in the repo | `{status:"Success", type:"list", pullRequests:[{id, branch, title, rating}]}` |
| `"prcheck <id-or-branch>"` | Start a fresh async review | `{status:"Accepted", message:"..."}` — poll with prcheckstatus |
| `"prcheckstatus <id-or-branch>"` | Get current state | See shapes below |
| `"prcomments <id-or-branch>"` | Same as prcheckstatus (alias) | Same shape |

### prcheckstatus response shapes

**Review still running:**
```json
{ "status": "Accepted", "message": "Review still in progress for <branch>..." }
```

**Completed (cached or fresh):**
```json
{
  "status": "Success",
  "type": "status",
  "productionScore": "7/10",
  "reviewRun": {
    "id": "run-...",
    "commitHash": "abc1234...",
    "rating": 7,             // numeric 1-10, or null if run failed
    "model": "MiniMax-M3",
    "completedAt": "2026-06-26T06:28:34.413Z"
  },
  "stale": false,            // true if diff has changed since this run
  "rejectedCount": 0,        // findings filtered by verifier
  "findingsCount": 4,
  "findings": [              // pre-formatted strings, NOT objects
    "[Correctness|warning] src/proxy.ts:40 — <explanation>",
    "[Security|suggestion] src/foo.ts:123 — <explanation>"
  ]
}
```

**No completed run yet:**
```json
{ "status": "Success", "message": "...\n_No completed ReviewRun yet._\n" }
```
The `message` field contains markdown; missing `reviewRun` field means no review has completed.

### prlist response shape
```json
{
  "status": "Success",
  "type": "list",
  "repoId": "...",
  "pullRequests": [
    { "id": "real-pr-...", "branch": "feature/x", "title": "...", "rating": "7/10" }
  ]
}
```

## Cache-aware review logic

`prcheck` always starts a fresh scan (no cache check in this endpoint). To avoid burning 15+ minutes re-scanning unchanged code, ALWAYS do this first:

1. Call `prcheckstatus <id>`.
2. If `status === "Accepted"` (in progress) → poll every 15s until `status === "Success"`.
3. If response has `reviewRun` and `stale === false` → return cached findings.
4. If response has no `reviewRun`, OR `stale === true` → call `prcheck <id>` to start fresh, then poll.

## Subcommand protocols

### `/gloop` (list mode)
1. Resolve repoId (see above). Stop if missing.
2. POST `prlist`.
3. Render PR list as a table. Number them 1..N (positional, for the user to reference as `/gloop <n>`).
4. Save the id↔ordinal mapping in memory for the next call.

### `/gloop <n>` (review mode)
1. Resolve repoId.
2. Translate `<n>` to a PR id: POST `prlist`, take `pullRequests[n-1].id`.
3. Run the cache-aware review logic above.
4. Render the rating, model, commitHash, and findings grouped by severity (blocker → warning → suggestion).
5. If rating < 8, suggest `/gloop fix <n>`.

### `/gloop status <n>`
1. Resolve repoId, translate ordinal → PR id.
2. POST `prcheckstatus <id>`.
3. If response has no `reviewRun`: tell user "No completed review yet — run `/gloop <n>` to start one."
4. Otherwise render findings. Do NOT call `prcheck`.

### `/gloop fix <n> [--once]`
1. Resolve repoId, translate ordinal.
2. Cache-aware review (see above). Wait for completion.
3. If `reviewRun.rating >= 8` → report PASS, exit.
4. For each findings string: parse `[Category|severity] file:line — explanation`, read the file at that line, apply a fix addressing the root cause (use the explanation as guidance — there's no diffSuggestion field in this API).
5. `git add -A && git commit -m "fix: address <n> findings from /gloop fix"`.
6. If `--once` → stop. Otherwise re-run cache-aware review (will be fresh since diff changed) and loop from step 3.
7. Stop after 3 iterations with no rating improvement, or rating >= 8.

## Polling timing

Full agentic scans take 5-25 min depending on PR size and model. Poll `prcheckstatus` every 15-30s. Don't poll faster — it spams the DB and doesn't speed anything up.

## Preconditions

- GrepLoop dev server running on port 3300 (`npm run dev` in the GrepLoop repo).
- Current repo registered and indexed in GrepLoop (writes `.greploop/repo-id` automatically).
- `GREPLOOP_API_KEY` env var set (generate from GrepLoop UI → Settings → API Keys).
- A PR exists for the current branch (or pass `<n>` explicitly to pick from the list).
