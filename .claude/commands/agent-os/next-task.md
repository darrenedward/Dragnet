# Next Task

Implement the next undone task from a spec's `tasks.md`. Reads the spec, finds the first `- [ ]`, implements it per the matching `plan.md` task, flips the checkbox to `- [x]`, commits with a phase-specific message, and reports back. Re-invoke to loop.

## Important Guidelines

- **Always update `tasks.md` in the same commit as the implementation** — the user's convention is "update tasks.md as we complete them," not "batch updates later."
- **One task per invocation.** Don't auto-loop multiple tasks without user check-in. The user decides when to call `/agent-os:next-task` again.
- **Match the plan precisely.** Each `- [ ]` in `tasks.md` should map to a documented task in `plan.md`. If the checkbox text doesn't match anything in the plan, surface the mismatch and ask before improvising.
- **Commit per task** — never batch phases into one commit. The commit history is the audit trail.
- **`npm run lint` clean before commit.** If lint fails, fix the issue; do not commit broken code.

## Process

### Step 1: Resolve the spec folder

If the user passed a spec folder name (e.g., `/agent-os:next-task 2026-06-27-large-pr-mode`), use it directly.

Otherwise, list `.agent-os/specs/` and use AskUserQuestion:

```
Which spec do you want to work on?

1. 2026-06-27-large-pr-mode
2. 2026-06-24-1746-review-freshness-guard
3. ...

(Pick a number, or paste a spec folder name)
```

If `.agent-os/specs/` doesn't exist or is empty, stop and tell the user.

### Step 2: Read tasks.md and find the next undone task

Read `.agent-os/specs/<spec-folder>/tasks.md`. Scan top-to-bottom for the first line matching `- [ ]`. That's the target task.

Note which **Phase** header it sits under (e.g., `## Phase 3 — Schema migration`) — the phase name goes in the commit message.

If no `- [ ]` remains, tell the user:

```
All tasks in <spec-folder> are complete. Run /agent-os:verify-spec to confirm
all checks pass, or pick a different spec.
```

Stop.

### Step 3: Cross-reference plan.md

Read `.agent-os/specs/<spec-folder>/plan.md`. Find the task whose description matches the checkbox text (or the phase + task number it corresponds to).

Confirm:
- The plan task has enough detail to implement (file paths, code patterns, verify steps).
- The plan task doesn't depend on a later task being done first.

If the plan task is ambiguous or underspecified, stop and tell the user what's missing. Don't improvise major design decisions during a single-task implementation.

### Step 4: Implement the task

Use the standard tools (Read, Edit, Write, Bash) to implement exactly what the plan describes.

Follow these rules from `CLAUDE.md`:
- **500-line file rule** — if a new file would exceed 500 lines, split into a directory.
- **`git add .` after every change** with a relative commit message.
- **Before removing code**, investigate the usecase first.
- **Search for existing code before creating new.**

If the task touches multiple files, do all edits before committing — one commit per task, not per file.

### Step 5: Verify

Run whatever verify step the plan task documents. Usually one of:
- `npm run lint` — TypeScript type check
- `npm test` — vitest suite
- `npm run build` — production build
- A specific test file listed in the plan

If verification fails, fix the issue before committing. Do not commit broken code.

### Step 6: Update tasks.md

In the same edit pass, flip the implemented task from `- [ ]` to `- [x]`:

```markdown
- [x] Add `ReviewChunk` model to `prisma/schema.prisma` (after `ReviewRun`, before `PullRequest`).
```

If the implementation differed from the plan (e.g., a different file path, an added sub-step), append a brief note to the line:

```markdown
- [x] Add `reviewChunkId` to `ReviewFinding` — moved to `ReviewLog` too (same attribution pattern).
```

### Step 7: Commit

Stage everything (`git add .`) and commit with a phase-specific message:

```
<type>(<spec-slug>): <task description>

- Implemented: <one-line summary>
- Spec: .agent-os/specs/<spec-folder>/tasks.md (Phase N)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Use the existing project commit style (check `git log --oneline -5` for tone). Common types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`.

### Step 8: Report and offer to continue

Output a short summary:

```
✓ Task complete: <task description>

Commit: <sha>
Phase: <N — phase name>
Files: <count> changed, <count> lines

Next undone task in this spec:
  Phase <N>: <next checkbox text>

Run /agent-os:next-task again to continue, or /agent-os:verify-spec to run all checks.
```

Stop. Do not auto-start the next task.

## Edge cases

### Blocked task

If the next undone task depends on something that doesn't exist yet (e.g., a schema field that hasn't been added), stop and tell the user:

```
Task "<text>" depends on "<prerequisite>" which isn't done yet.
The prerequisite is in Phase <N>, task "<text>".
Implement that first.
```

### Out-of-order tasks

If checkboxes in an earlier Phase are still undone but a later Phase has done items (someone implemented out of order), don't silently fix it. Surface the inconsistency and ask.

### Manual verification tasks

Some tasks end with `(Requires DB push — user action.)` or similar. These can't be auto-verified. Mark them `- [x]` only after the user confirms the manual step is done; otherwise leave `- [ ]` and move to the next automatable task.

## Tips

- **Read the whole plan task before starting** — half-finished implementations come from reading only the first sentence.
- **If you discover the plan is wrong, stop** — don't paper over a design error during a single-task sprint. Surface it and update the plan first.
- **One concern per commit** — if a task naturally splits into two concerns, that's two tasks. Note it in tasks.md and commit only the first.
