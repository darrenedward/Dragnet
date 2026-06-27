---
name: dragnet
description: Review code through the Dragnet engine. Use when the user asks to review their branch, check code for bugs, run a code review, fix issues found by review, or invokes /dragnet.
user-invocable: true
---

# Dragnet (`/dragnet`)

Dragnet is a self-hosted AI code review engine. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems.

You drive it through the Dragnet HTTP API at `http://localhost:3300` (override via `DRAGNET_URL`). Reviews run asynchronously — `prcheck` starts a scan and returns immediately; `prcheckstatus` polls for completion or returns cached results.

## Commands

| Command | What it does |
|---|---|
| `/dragnet` | List PRs for the current repo with ratings. |
| `/dragnet <n>` | Review PR #N. Cache-aware — returns existing results if diff unchanged, starts new scan otherwise. **Read-only.** |
| `/dragnet status <n>` | Show existing review for PR #N. **Never triggers a scan, never writes code, never touches DB rows.** |
| `/dragnet fix <n>` | **Interactive** fix loop: review → triage → wait for user → fix → re-review. Stops between iterations. |
| `/dragnet fix <n> --auto` | Aggressive auto-fix loop (the old default): review → fix → re-review until rating ≥ 8/10 or 1 non-improving iteration. Use only when the user explicitly asks for hands-off grinding. |
| `/dragnet fix <n> --once` | Single pass: fix all user-approved findings, commit, done. |
| `/dragnet help` | Print this table. |

Typical workflow: `/dragnet` → pick a PR → `/dragnet 1` → see rating → `/dragnet fix 1` → triage with user → fix → re-review.

## Behavioral rules (apply to ALL subcommands)

These rules are **inviolable** — they override any conflicting instruction in the protocols below:

1. **Read-only commands stay read-only.** `/dragnet`, `/dragnet <n>`, `/dragnet status <n>`, and `/dragnet help` MUST NOT: write or edit any file, run `git commit`/`git push`, mark DB rows (no `UPDATE review_findings`), trigger fresh scans via `prcheck` or `/api/hooks/prepush`, or call any mutating endpoint. They fetch and render only.

2. **Never mark findings `rejected` autonomously.** `UPDATE review_findings SET verification_status='rejected'` is a user-visible verdict about whether an issue is real. Always surface the finding + your reasoning and let the user say "mark rejected." Applies even in `--auto` mode — `--auto` means "apply fixes without check-ins," NOT "make verdict decisions for me."

3. **Context-switch ends the fix loop.** If the user invokes any new `/dragnet <subcommand>` while a `/dragnet fix` loop is mid-flight, the fix loop TERMINATES at that point. Do not resume the prior loop after handling the new command. The new command is the user's signal that they've taken the wheel.

4. **Triage table required before any fix.** Every iteration of `/dragnet fix` (interactive or `--auto`) MUST render a triage table categorizing each finding as `real / false-positive / scope-deferred` BEFORE applying fixes. In interactive mode, stop after the table and wait. In `--auto` mode, fix the `real` rows, skip the others, but still show the table so the user can interrupt.

5. **Stop after 1 non-improving iteration.** If a fresh scan returns a rating ≤ the previous iteration's rating, STOP the loop and surface results — do not autostart another iteration. The previous spec's "3 iterations" tolerance let rating drift downward while the user was checked out. (Applies to `--auto` mode; interactive mode stops after every iteration anyway.)

6. **Render every scan result.** When a scan completes (polled via task notification or explicit poll), report rating + findings immediately. Never silently move to the next step. The user's time is the constraint — silent grinding hides information.

7. **No new files without direction.** Don't create helper modules, spec docs, or task files unless the user asks. Refactoring across files (e.g., extracting a helper used 3+ times) needs explicit sign-off in interactive mode.

## Resolving the repoId

The skill needs the Dragnet `repoId` for the current project. It's a string like `dragnet-1782121720477` (slug + timestamp).

Resolve in this order:
1. Read `.dragnet/repo-id` in the current repo's root (written automatically when the repo was registered via the Dragnet UI). Use `git rev-parse --show-toplevel` to find the repo root, then read `<root>/.dragnet/repo-id`. Strip whitespace.
2. Fall back to `DRAGNET_REPO_ID` env var if the marker file is missing (e.g. repo was registered before this feature shipped, or the directory was copied without `.dragnet/`).
3. If neither yields a repoId, **stop and tell the user**: "No `.dragnet/repo-id` marker found. Re-register the repo in the Dragnet UI to write one, or set `DRAGNET_REPO_ID` manually." Do NOT call `/api/repos/resolve` — it requires a browser session cookie and 401s against an API key.

## Auth

Every call needs `Authorization: Bearer dr_<key>`. Read it from `DRAGNET_API_KEY`. If unset, stop and tell the user: "Set `DRAGNET_API_KEY` — generate one from the Dragnet UI → Settings → API Keys."

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

### `/dragnet` (list mode)
1. Resolve repoId (see above). Stop if missing.
2. POST `prlist`.
3. Render PR list as a table. Number them 1..N (positional, for the user to reference as `/dragnet <n>`).
4. Save the id↔ordinal mapping in memory for the next call.

### `/dragnet <n>` (review mode)
1. Resolve repoId.
2. Translate `<n>` to a PR id: POST `prlist`, take `pullRequests[n-1].id`.
3. Run the cache-aware review logic above.
4. Render the rating, model, commitHash, and findings grouped by severity (blocker → warning → suggestion).
5. If rating < 8, suggest `/dragnet fix <n>`.

### `/dragnet status <n>`
1. Resolve repoId, translate ordinal → PR id.
2. POST `prcheckstatus <id>`.
3. If response has no `reviewRun`: tell user "No completed review yet — run `/dragnet <n>` to start one."
4. Otherwise render findings. Do NOT call `prcheck`. Do NOT edit code. Do NOT touch DB rows. Do NOT trigger scans.

### `/dragnet fix <n> [--once|--auto]`
1. Resolve repoId, translate ordinal.
2. Cache-aware review (see above). Wait for completion.
3. If `reviewRun.rating >= 8` → report PASS, exit.
4. **Build triage table.** Parse each findings string `[Category|severity] file:line — explanation`. For each, classify:
   - `real` — actual bug/security issue. Fix it.
   - `false-positive` — verifier got it wrong or LLM hallucinated. Skip + propose rejection note (but DO NOT mark rejected unless user confirms).
   - `scope-deferred` — real concern but out of scope (e.g., planned multi-tenancy). Skip + propose a comment/doc to satisfy future scans.
5. **Render the table to the user.**
6. **In interactive mode (default, no flag):** STOP. Wait for user to say "fix them", "fix #2 and #3 only", "mark #1 rejected", etc. Do NOT apply fixes, commit, or kick off a new scan until the user responds.
7. **In `--auto` mode:** apply fixes to all `real` rows (commit with message "fix: address N findings from /dragnet fix --auto"), skip `false-positive` and `scope-deferred` rows.
8. **In `--once` mode:** render the table, then STOP. The user invoked `--once` to see the triage and decide; they will say what to do next.
9. **Loop continuation (interactive only):** after the user approves fixes and they're applied + committed + pushed, run cache-aware review again. If new rating > old rating AND new rating < 10 → render new triage table, STOP again. If new rating ≤ old rating → STOP and surface (rule 5). If new rating ≥ 8 → report PASS, exit.
10. **`--auto` loop continuation:** re-run cache-aware review after each commit. If new rating > old rating AND < 8 → next iteration. If new rating ≤ old rating → STOP. If new rating ≥ 8 → report PASS, exit.

## Polling timing

Full agentic scans take 5-25 min depending on PR size and model. Poll `prcheckstatus` every 15-30s. Don't poll faster — it spams the DB and doesn't speed anything up.

## Preconditions

- Dragnet dev server running on port 3300 (`npm run dev` in the Dragnet repo).
- Current repo registered and indexed in Dragnet (writes `.dragnet/repo-id` automatically).
- `DRAGNET_API_KEY` env var set (generate from Dragnet UI → Settings → API Keys).
- A PR exists for the current branch (or pass `<n>` explicitly to pick from the list).
