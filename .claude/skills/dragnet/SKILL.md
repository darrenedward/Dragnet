---
name: dragnet
description: Review code through the Dragnet engine. Use when the user asks to review their branch, check code for bugs, run a code review, fix issues found by review, or invokes /dragnet.
user-invocable: true
---

# Dragnet (`/dragnet`)

Dragnet is a self-hosted AI code review engine. It indexes the codebase, builds a call graph, and runs an agentic review loop with tool access to find bugs, security issues, and correctness problems.

You drive it through the Dragnet HTTP API at `http://localhost:3300` (override via `DRAGNET_URL`). Reviews run asynchronously — `prcheck` starts a scan and returns immediately; `prcheckstatus` polls for completion or returns cached results.

## Execution recipe (run verbatim — every command)

**Every `/dragnet` subcommand ends with one HTTP POST to `/api/command`.** If you haven't POSTed yet, you're not done. The steps below are the entire workflow — no git exploration, no diff inspection, no source-file reading.

**Forbidden git commands:** `git log`, `git diff`, `git branch`, `git status`, `git show`, `git blame`, etc. The ONLY git command this skill ever runs is `git rev-parse --show-toplevel`, and that's just to locate the repo root so it can read `.dragnet/repo-id`. The skill is a thin HTTP client; the Dragnet API already holds the diff, call graph, and findings.

### Step 1 — resolve repoId + API key (one block, runs both lookups)

```bash
ROOT=$(git rev-parse --show-toplevel)                       # path only
REPO_ID=$(tr -d '[:space:]' < "$ROOT/.dragnet/repo-id" 2>/dev/null)
[ -z "$REPO_ID" ] && REPO_ID=$(jq -r .repoId "$ROOT/.dragnet/cred.json" 2>/dev/null)
KEY=$(jq -r .key "$ROOT/.dragnet/cred.json" 2>/dev/null)
[ -z "$KEY" ] && KEY="$DRAGNET_API_KEY"
URL="${DRAGNET_URL:-http://localhost:3300}"
echo "repoId=$REPO_ID key=${KEY:0:10}... url=$URL"
```

If `REPO_ID` or `KEY` is empty: **stop and tell the user** which is missing and how to fix (re-register the repo in Dragnet UI; or generate an API key from Settings → API Keys). Do not continue to step 2.

### Step 2 — POST to `/api/command`

The `command` field is the subcommand + arg. Numeric ordinals (`1`, `2`) are NOT accepted — translate via `prlist` first. Example for `/dragnet status 1`:

```bash
N=1
PR_ID=$(curl -s -X POST "$URL/api/command" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"command\":\"prlist\",\"repoId\":\"$REPO_ID\"}" \
  | jq -r ".pullRequests[$N-1].id")

curl -s -X POST "$URL/api/command" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"command\":\"prcheckstatus $PR_ID\",\"repoId\":\"$REPO_ID\"}"
```

### Step 3 — render the response

See response shapes below. Read-only commands (`prlist`, `prcheckstatus`, `prcomments`) just render — never trigger scans, edit files, or touch DB rows.

### CRITICAL — never transcribe secrets by hand

`$KEY` and `$REPO_ID` are long hex strings. **Never copy their values into subsequent commands** — always write `-H "Authorization: Bearer $KEY"` and let the shell substitute. LLM transcription of 64-char hex strings is the #1 cause of 401 errors with this skill.

If `prlist` returns 401 with `{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized..."}}`:

1. **Don't second-guess `cred.json`** — it's almost certainly correct.
2. **Don't read the key value and retype it** — that's what caused the 401. Re-run Step 1 + Step 2 as written, using `$KEY` verbatim.
3. Confirm by running this exact line (no transcription):
   ```bash
   ROOT=$(git rev-parse --show-toplevel)
   KEY=$(jq -r .key "$ROOT/.dragnet/cred.json")
   REPO_ID=$(jq -r .repoId "$ROOT/.dragnet/cred.json")
   curl -s -X POST "${DRAGNET_URL:-http://localhost:3300}/api/command" \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d "{\"command\":\"prlist\",\"repoId\":\"$REPO_ID\"}" -w "\nHTTP %{http_code}\n"
   ```
4. If you still get 401, the key may have been revoked — tell the user to regenerate it from the Dragnet UI → Settings → API Keys.

### Stale index — what to do

`prcheckstatus` (used by `/dragnet status <n>`) **never** returns this error — it surfaces the most recent cached findings regardless of freshness. If you see Stale Index while running `/dragnet status <n>`, **you called the wrong command** — go back and use `prcheckstatus`, not `prcheck`.

Only `prcheck` (used by `/dragnet <n>` and `/dragnet fix <n>`) checks freshness and returns:

```json
{"status":"Error","message":"> ⚠ **Stale index**..."}
```

When you see this: **stop and tell the user** — *"Index is stale. Open the Dragnet dashboard at `http://localhost:3300`, click the repo, and hit **Reindex**. Then re-run `/dragnet <n>`."*

The `/api/repos/$REPO_ID/reindex` endpoint exists but **requires a browser session cookie, not an API key** — the CLI skill cannot trigger reindex itself. Don't try `reindex` as a `/api/command` subcommand; it returns `Unknown command: reindex`. Don't try `/api/repos/*/reindex` via curl either; it returns 401.

## Commands

| Command | What it does |
|---|---|
| `/dragnet` | List PRs for the current repo with ratings. |
| `/dragnet <n>` | Review PR #N. Cache-aware — returns existing results if diff unchanged, starts new scan otherwise. **Read-only.** |
| `/dragnet status <n>` | Show existing review for PR #N. **Never triggers a scan, never writes code, never touches DB rows.** |
| `/dragnet fix <n>` | **Interactive** fix loop: review → triage → wait for user → fix → re-review. Stops between iterations. |
| `/dragnet fix <n> --auto [--loops N]` | Aggressive auto-fix loop: review → fix → re-review until rating = 10/10, 1 non-improving iteration, or N iterations elapsed (default N=5). The target is **10/10, not 8/10** — bailing at 8 hides the remaining 20%. Use when the user explicitly asks for hands-off grinding to the top of the scale. `--loops 3` caps at 3 iterations; `--loops 10` is the hard ceiling. |
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

8. **Rating doesn't end interactive mode.** An 8/10 means "production-grade" per the rubric — it's not a ceiling and not a stop signal. The LLM grades honestly on a 1-10 scale: 9 means "only nit-level suggestions," 10 means "flawless." If you bail out of `/dragnet fix <n>` (interactive, default mode) just because rating ≥ 8, you're capping the scale at 8 and hiding the findings that would push it higher. **Always render the triage table in interactive mode, regardless of rating (8, 9, 10, or lower) and STOP for user input.** The only rating that ends ANY loop (`--auto` included) is **10/10** — bailing at 8 because "it's production-grade" is the cancer-80%-go-home fallacy. If you can reach 9 or 10, you reach 9 or 10.

## Resolving the repoId

The skill needs the Dragnet `repoId` for the current project. It's a string like `dragnet-1782121720477` (slug + timestamp).

Resolve in this order:
1. Read `.dragnet/repo-id` in the current repo's root (written automatically when the repo was registered via the Dragnet UI). Use `git rev-parse --show-toplevel` to find the repo root, then read `<root>/.dragnet/repo-id`. Strip whitespace.
2. Fall back to `.dragnet/cred.json` → `jq -r .repoId <root>/.dragnet/cred.json`. This file is written by the install modal and holds the same repoId as the marker.
3. Fall back to `DRAGNET_REPO_ID` env var if both files are missing.
4. If none yield a repoId, **stop and tell the user**: "No `.dragnet/repo-id` marker found. Re-register the repo in the Dragnet UI to write one, or set `DRAGNET_REPO_ID` manually." Do NOT call `/api/repos/resolve` — it requires a browser session cookie and 401s against an API key.

## Auth

Every call needs `Authorization: Bearer dr_<key>`. Resolve the key in this order:

1. `.dragnet/cred.json` at the repo root → `jq -r .key <root>/.dragnet/cred.json`. This file is written by the install modal and is what `mcp.sh` reads at runtime, so it's the canonical source.
2. `$DRAGNET_API_KEY` env var as a fallback (interactive shells that have sourced `~/.zshrc`).
3. If neither yields a key, **stop and tell the user**: "No API key in `.dragnet/cred.json` or `$DRAGNET_API_KEY`. Generate one from the Dragnet UI → Settings → API Keys."

**Note for agents:** Claude Code's Bash tool runs commands in a non-interactive shell that does not source `~/.zshrc`, so `$DRAGNET_API_KEY` will typically be empty even if the user has exported it in their terminal. **Always try `.dragnet/cred.json` first** — it works across all execution contexts.

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

**Review still running (scan in progress):**
```json
{
  "status": "Scanning",
  "message": "> Scan in progress for <branch>...",
  "sizeProfile": {...},
  "progress": {
    "chunksCompleted": 1,
    "chunksTotal": 3,           // large PRs are split into chunks
    "chunksFailed": 0,
    "chunksSkipped": 0,
    "iteration": 4,             // current agentic-loop round
    "maxIterations": 8,         // hard cap per chunk
    "partialFindingsCount": 2,  // already persisted, viewable mid-scan
    "startedAt": "2026-06-28T..."
  }
}
```
(Older servers returned `"Pending"` here without the `progress` field — treat both as "keep polling". `"Accepted"` is what `prcheck` returns immediately after starting a scan; `prcheckstatus` switches to `"Scanning"` while the scan runs.)

**On chunking:** large PRs are split into multiple chunks; each chunk runs its own agentic loop (up to `maxIterations` rounds). Small PRs run as a single chunk. `progress.iteration` is the highest round across all chunks — it's the LLM's "thinking round", not the chunk index. Use `chunksCompleted/chunksTotal` for overall progress.

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
    "completedAt": "2026-06-26T06:28:34.413Z",
    "refused": false,        // true if reviewer flagged it skipped/declined part of the PR
    "refusalNote": null      // string when refused=true: topics the reviewer skipped
  },
  "stale": false,            // true if diff has changed since this run
  "rejectedCount": 0,        // findings filtered by verifier
  "findingsCount": 4,
  "findings": [              // pre-formatted strings, NOT objects
    "[Correctness|warning|moderate] src/proxy.ts:40 — <explanation>",
    "[Security|suggestion|difficult] src/foo.ts:123 — <explanation>"
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
2. If `status === "Scanning"` (or `"Accepted"` / `"Pending"` on older servers) → poll at the size-tiered interval (see Polling timing below) until `status === "Success"`.
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
5. **If `reviewRun.refused === true`:** render a prominent warning at the top — `⚠ Reviewer flagged incomplete coverage: <refusalNote>`. The review ran but parts of the PR were skipped (security filter, scope, etc.). Re-scan after addressing the cause.
6. If rating < 8, suggest `/dragnet fix <n>`.

### `/dragnet status <n>`
1. Resolve repoId, translate ordinal → PR id.
2. POST `prcheckstatus <id>`.
3. If response has no `reviewRun`: tell user "No completed review yet — run `/dragnet <n>` to start one."
4. Otherwise render findings. **If `reviewRun.refused === true`:** render a prominent warning at the top — `⚠ Reviewer flagged incomplete coverage: <refusalNote>` — and recommend a re-scan.
5. Do NOT call `prcheck`. Do NOT edit code. Do NOT touch DB rows. Do NOT trigger scans.

### `/dragnet fix <n> [--once|--auto [--loops N]]`
1. Resolve repoId, translate ordinal. Parse flags: `--once`, `--auto`, `--loops N` (integer 1-10; default 5 if `--auto` without `--loops`; clamped to 10 max). Unknown flags → error + show help.
2. Cache-aware review (see above). Wait for completion.
3. **(--auto only)** If `reviewRun.rating = 10` → report PERFECT, exit after rendering the triage table. Interactive mode skips this step — see rule 8.
4. **Build triage table.** Parse each findings string `[Category|severity|exploitability?] file:line — explanation` (third bracket segment is optional — older cached responses lack it; treat as "unrated" when missing). For each, classify:
   - `real` — actual bug/security issue. Fix it.
   - `false-positive` — verifier got it wrong or LLM hallucinated. Skip + propose rejection note (but DO NOT mark rejected unless user confirms).
   - `scope-deferred` — real concern but out of scope (e.g., planned multi-tenancy). Skip + propose a comment/doc to satisfy future scans.
   - When rendering the table, surface `exploitability` (trivial/moderate/difficult) and `impact` (critical/high/medium/low) as columns if present. Prioritization rule of thumb: trivial+critical first, difficult+low last. Treat missing values as "unrated" — don't infer.
5. **Render the table to the user.** Always — even if rating is 8, 9, or 10. Findings at those ratings are usually suggestions, and the user gets to decide whether to chase a higher score or ship.
6. **In interactive mode (default, no flag):** STOP. Wait for user to say "fix them", "fix #2 and #3 only", "mark #1 rejected", "done", etc. Do NOT apply fixes, commit, or kick off a new scan until the user responds. Do NOT auto-exit on rating.
7. **In `--auto` mode:** apply fixes to all `real` rows (commit with message "fix: address N findings from /dragnet fix --auto"), skip `false-positive` and `scope-deferred` rows.
8. **In `--once` mode:** render the table, then STOP. The user invoked `--once` to see the triage and decide; they will say what to do next.
9. **Loop continuation (interactive only):** after the user approves fixes and they're applied + committed + pushed, run cache-aware review again. Render the new triage table regardless of rating. STOP again. The loop ends when the user says "done"/"exit", OR when rule 5 trips (new rating ≤ old rating), OR when there are no `real` findings left to triage.
10. **`--auto` loop continuation:** re-run cache-aware review after each commit. If new rating = 10 → report PERFECT, exit. If new rating > old rating AND iterations < maxLoops → next iteration. If new rating ≤ old rating (1 non-improving iteration, per rule 5) → STOP. If maxLoops reached without hitting 10/10 → STOP, surface final state. **maxLoops defaults to 5** and is overridable via `--loops N` (e.g. `--loops 3`, `--loops 10`). Hard ceiling at 10 iterations even if user passes a higher N — prevents runaway token spend when the LLM plateaus.

## Polling timing

Polling interval scales with PR size — `prlist` and `prcheckstatus` both return `sizeProfile.tier` (`small` / `medium` / `large`). Pick the interval from the table; the goal is roughly 3–5 polls total, not a poll every 15s for 10 minutes.

| `sizeProfile.tier` | Typical scan duration | Poll interval | Max polls |
|---|---|---|---|
| `small` (under ~100 code lines) | ~1 min | 30s | 4 |
| `medium` (~100–1000 code lines) | ~3 min | 60s | 6 |
| `large` (1000+ code lines) | 5–10 min | 120s | 8 |
| missing / unknown | — | 60s | 8 |

**Example:**
```bash
INTERVAL=60   # tier=medium; pick based on sizeProfile.tier
for i in $(seq 1 6); do
  sleep $INTERVAL
  R=$(curl -s -X POST "$URL/api/command" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"command\":\"prcheckstatus $PR_ID\",\"repoId\":\"$REPO_ID\"}")
  echo "poll $i: $(echo "$R" | jq -c '{status, productionScore, findingsCount, progress: (.progress // null)}')"
  [ "$(echo "$R" | jq -r .status)" = "Success" ] && break
done
echo "$R" | jq .
```

Don't poll faster than the table — it spams the DB and doesn't speed anything up.

## Preconditions

- Dragnet dev server running on port 3300 (`npm run dev` in the Dragnet repo).
- Current repo registered and indexed in Dragnet (writes `.dragnet/repo-id` automatically).
- `DRAGNET_API_KEY` env var set (generate from Dragnet UI → Settings → API Keys).
- A PR exists for the current branch (or pass `<n>` explicitly to pick from the list).
