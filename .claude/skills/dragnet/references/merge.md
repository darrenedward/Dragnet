# `/dragnet merge` protocol

Stack-aware merge orchestrator. Dragnet rates PRs 1-10; this subcommand takes PRs rated ≥8, walks the stack topology, surfaces reality/problems, presents strategy options via AskUserQuestion, verifies live `gh` state, and executes merges on approval.

**Trust-but-verify mandate.** Dragnet's `prlist` response includes topology fields (`stackDepth`, `dependencies`, `unscannedDepsCount`), but the underlying `targetBranch` column is set at PR creation and never re-synced from GitHub (see `src/lib/getRealLocalPrs.ts:175`). For retargeted PRs (common in stacked-PR workflows), Dragnet's topology is **stale**. The skill MUST run `gh pr list --json baseRefName,headRefName` for the authoritative view. Dragnet's topology is a hint; `gh` is truth.

## Commands

- `/dragnet merge` — list all PRs rated ≥8, analyze stacks, present strategy options
- `/dragnet merge <n,n,...>` — scoped to listed ordinals (e.g. `1`, `1,7,8`, `1-4`)
- `/dragnet merge --merge` / `--rebase` / `--keep-branch` — override default `--squash --delete-branch`

## Inputs

- Ordinals from `/dragnet prlist` (NOT GitHub PR numbers — translate via `prlist` first)
- Optional flags: `--merge`, `--rebase`, `--keep-branch`, `--force`, `--dry-run`

## Protocol

### Step 1 — Resolve repoId + API key

Follow SKILL.md steps 1-2 verbatim. POST to `/api/command` with `prlist`.

### Step 2 — Fetch candidates + topology (two sources)

**Source A (Dragnet advisory):** `prlist` response gives `{branch, rating, stackDepth, dependencies, unscannedDepsCount}` per PR. Filter to `rating >= 8` (parse `"X/10"`; skip `"Not scanned"`).

**Source B (gh authoritative):**
```bash
gh pr list --state open --json number,title,baseRefName,headRefName,mergeable,isDraft,statusCheckRollup,reviewDecision
```

Cross-reference by `headRefName == branch` (Dragnet) ↔ `headRefName` (gh). Build the **live** stack graph from gh's `baseRefName`/`headRefName` edges — this is authoritative. Dragnet's `stackDepth` is a sanity check; if the two disagree, gh wins.

If args present (`1` or `1,7,8` or `1-4`), filter the candidates to those ordinals (translated via `prlist` ordering). Else take all ≥8.

### Step 3 — Render Reality/Problem table

For each candidate, walk gh's stack graph backward to identify dependencies. Then render:

```
| PR | Reality | Problem |
|----|---------|---------|
| #1 | Base=main, standalone | None — safe |
| #7 | Base=fix/skills-skillversion (#6, unscanned) | Drags unreviewed #6 work into main |
| #8 | Base=fix/skills-url, CONFLICTING | Cannot merge until resolved |
```

Reality columns: PR number, base branch, dependency chain (with scan status), mergeable state, CI state, draft state.

Problem column: one-line summary of what blocks or risks this merge.

### Step 4 — Verification pass (trust-but-verify per PR)

For each candidate AND each transitive dependency, run:
```bash
gh pr view <number> --json mergeable,isDraft,statusCheckRollup,reviewDecision,baseRefName,headRefName
```

Re-check immediately before merge execution too — state drifts in real time.

### Step 5 — Apply hard gates (NO override)

Refuse to merge (skip the PR, continue to others) if:
- `mergeable: CONFLICTING` — must resolve manually
- `isDraft: true` — must mark ready

Surface in the strategy options as "deferred: hard gate."

### Step 6 — Apply soft gates (override with `--force`)

- Rating < 8 (shouldn't happen post-filter; defensive)
- Any CI check failing or pending
- Unresolved blocking review comments (`reviewDecision: REVIEW_REQUIRED` or `CHANGES_REQUESTED`)
- Unscanned dependency in the chain (`unscannedDepsCount > 0` in Dragnet advisory OR gh-derived deps include PRs with no completed review)

Without `--force`, surface these as "deferred: soft gate." With `--force`, override with explicit warning that the user accepts the risk.

### Step 7 — Synthesize strategies

Based on gate results, enumerate 2-4 viable strategies. The skill's LLM reasoning applies these rules in priority order:

1. **Unscanned dependency** → defer (don't land unreviewed code)
2. **CONFLICTING** → defer (manual resolution required)
3. **Draft** → defer (must mark ready)
4. **All-green standalone** → safe to merge

Typical strategy shapes:
- "Merge only standalone safe PRs (defer the rest)" — recommended when there's a mix
- "Merge X, accept that unscanned Y rides along" — only with `--force`, surface the tradeoff explicitly
- "Merge in stack order: #1, #2, #3" — when full stack is green and scanned
- "Stop — too many gaps to proceed safely" — when no PR can merge cleanly

### Step 8 — AskUserQuestion

Present strategies as multiple-choice via AskUserQuestion. First option is the recommendation. Each option's description must state: which PRs merge, which defer, and the tradeoff.

Example:
```
Question: Which merge strategy do you want?
1. Merge #1 only (Recommended) — PR #1 is standalone, 9/10, all-green. Defer #7 (stacked on unscanned #6) and #8 (conflicts).
2. Merge #1 and #7 with --force — Merge #1 cleanly, then merge #7 knowing PR #6's unreviewed commits ride along. Skip #8 (conflicts).
3. Merge #1, then stop — Just #1. Address #6 scan + #8 conflicts in a separate session.
4. Stop, none of these — Leave all three PRs open.
```

If `--dry-run`, render the table + strategies, then exit WITHOUT calling AskUserQuestion (skip execution).

### Step 9 — Execute on pick

For each PR in the chosen strategy, in **stack-root-first order** (deepest dependency first):

1. **Re-verify mergeable** (state may have drifted during user deliberation):
   ```bash
   gh pr view <number> --json mergeable
   ```
   If `mergeable: CONFLICTING` now → refuse, continue to next PR.

2. **Merge** with the configured method (default `--squash --delete-branch`):
   ```bash
   gh pr merge <number> --squash --delete-branch --auto
   ```
   `--auto` lets GitHub wait for any pending CI to complete before merging. Override flags: `--merge` (merge commit, keep branch), `--rebase` (rebase + delete), `--keep-branch` (any method, no delete).

3. **Poll until terminal** (max 60s, 5s interval):
   ```bash
   gh pr view <number> --json state,mergeStateStatus
   ```
   Terminal states: `MERGED`, `CLOSED` (without merge — failed), or 60s timeout.

4. **Stop on first failure.** No rollback (impossible after merge). Report what merged, what's still open, and the failure reason. Let the user investigate.

### Step 10 — Render final state

```
Merge results:
  ✓ #1 feat: AI chat scaffolding        MERGED  (squash, branch deleted)
  ⏸ #7 feat: skills registry             OPEN   (deferred: unscanned dep #6)
  ✗ #8 feat: bulk skills                 FAILED (mergeable=CONFLICTING)

Next steps:
  - Scan #6 then re-run /dragnet merge 7
  - Resolve #8 conflicts locally, push, re-run /dragnet merge 8
```

## Forbidden

- **Merging without explicit AskUserQuestion approval.** No autonomous merges, even with `--force`. `--force` bypasses soft gates only; the user must still pick a strategy.
- **Merging `mergeable: CONFLICTING` or `isDraft: true`** regardless of flags. Hard gates have no override.
- **Continuing after a merge failure.** Stop, report, let the user investigate. No batch rollback.
- **Trusting Dragnet's cached topology for the actual merge execution.** `gh` is authoritative at execution time. If Dragnet said "mergeable, depth=0" but `gh` says "CONFLICTING, depth=3", the merge is refused and re-rendered.
- **Creating new branches or PRs.** This subcommand only merges existing PRs. If the user wants to split or retarget, they do it manually.

## Edge cases

- **Stack-root-first ordering:** when merging multiple PRs in a stack, always merge the deepest dependency first. GitHub auto-retargets dependents on merge, so the next PR's base updates to `main`.
- **GitHub retargeting lag:** after merging PR #1, GitHub may take a few seconds to retarget PR #2's base. Poll `gh pr view <number> --json mergeable` up to 30s before assuming the next PR is ready.
- **`gh pr merge --auto` semantics:** returns immediately if CI is green; queues the merge if CI is pending. The skill polls state regardless.
- **No PRs match the filter:** render "No PRs rated ≥8 — nothing to merge" and exit. Don't prompt with empty strategies.
- **User passes ordinals out of stack order (`/dragnet merge 5,1,3`):** the skill re-sorts to stack-root-first internally; render the corrected order in the strategy options with a note.
