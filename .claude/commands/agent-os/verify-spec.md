# Verify Spec

Run all automated checks for a spec and report per-phase pass/fail. Reads `tasks.md`, runs `npm run lint` / `npm test` / `npm run build`, identifies which phases are blocked or incomplete, and surfaces anything that needs attention before the spec can be called done.

Does **not** implement anything. Read-only verification.

## Important Guidelines

- **Read-only.** This command runs checks and reports. It does not edit code, flip checkboxes, or commit. If a check fails, the user decides whether to fix it (via `/agent-os:next-task`) or accept the gap.
- **Distinguish automated from manual.** `npm run lint` is automated. `Manual: trigger scan on synthetic 1500-line PR` is not. Report them separately.
- **Don't gate on tests that were deferred.** Some specs mark a test as `[ // deferred — needs HTTP mocking]`. Read the annotation; don't fail the spec for an explicit deferral.
- **One report, not a stream.** Run all checks, then produce one structured report. The user wants the bottom line, not live-tweeted progress.

## Process

### Step 1: Resolve the spec folder

Same as `/agent-os:next-task`: take the arg, or list `.agent-os/specs/` and ask.

### Step 2: Read tasks.md and classify each checkbox

Parse every line. Categorize:

| Pattern | Category |
|---|---|
| `- [x] ...` | **Done** |
| `- [ ] ... npm run lint clean.` | **Auto-verifiable** (lint) |
| `- [ ] ... npm test ...` / `- [ ] ... write <test>.test.ts ...` | **Auto-verifiable** (tests) |
| `- [ ] ... npm run build ...` | **Auto-verifiable** (build) |
| `- [ ] Manual: ...` | **Manual** |
| `- [ ] <anything else>` | **Implementation** (not verifiable by this command) |

Count items per category per phase.

### Step 3: Run automated checks

Execute in this order, capturing pass/fail and any error output:

1. **Lint:** `npm run lint` (TypeScript type check via `tsc --noEmit`)
2. **Tests:** `npm test` (vitest suite)
3. **Build:** `npm run build` (Next.js production build)

For each, record:
- Exit code
- Time taken
- First error message (if failed)

If lint fails, tests and build are likely to fail too — still run all three for completeness, but note the cascade.

### Step 4: Cross-reference tasks.md state

For each phase, determine:

- **Complete:** all checkboxes `- [x]`, no exceptions.
- **Implementation pending:** some `- [ ]` items remain (implementation work).
- **Verification pending:** all implementation `- [x]`, but a `npm test` / `npm run build` / `Manual:` checkbox is still `- [ ]`.
- **Blocked:** a `npm run lint clean.` checkbox is `- [ ]` AND lint actually fails — the checkbox correctly reflects reality.

### Step 5: Produce the report

Format:

```
# Spec verification — <spec-folder>

## Automated checks

| Check | Result | Time |
|---|---|---|
| npm run lint  | PASS | 4.2s |
| npm test      | FAIL | 12.8s |
| npm run build | PASS | 38.1s |

Test failure: tests/largePrMode/aggregator.test.ts > "dedup by (filename, line, category)"
  Expected: 1 finding
  Received: 2 findings

## Per-phase status

| Phase | Done | Pending | Manual | Status |
|---|---|---|---|---|
| 1 — Spec documentation    | 3/3 | 0 | 0 | ✓ complete |
| 2 — Prerequisites         | 2/3 | 1 | 0 | implementation pending |
| 3 — Schema migration      | 6/6 | 0 | 0 | ✓ complete |
| 4 — Diff manifest         | 6/8 | 2 | 0 | implementation pending |
| ...                       |     |   |   |   |
| 10 — Final verification   | 0/4 | 1 | 3 | verification pending |

## Bottom line

Spec is **not ready to ship**.

Blockers (must fix):
- Phase 4: 2 implementation tasks remaining (chunker.test.ts, securitySensitive.test.ts)
- Tests failing in aggregator.test.ts — fix before next commit

Deferrals (acceptable):
- Phase 10 has 3 manual verification tasks — these require running the dev server
  and triggering real scans. Mark them done manually after running.

Next: /agent-os:next-task <spec-folder> to implement the next pending task.
```

### Step 6: Don't update tasks.md

This command is read-only. Even if a check passes that has a `- [ ]` checkbox (e.g., `npm run lint clean.` is currently `- [ ]` but lint passes), do not flip the checkbox. The checkbox represents "the work was done as part of the matching implementation task" — flipping it here would decouple the audit trail from commits.

If the user wants to clean up stale verification checkboxes, they do it manually.

## Edge cases

### Spec has no tasks.md

Stop and tell them:

```
No tasks.md in <folder>. Run /agent-os:write-tasks <folder> first.
```

### tasks.md is empty or malformed

If parsing finds zero checkboxes, stop and report:

```
tasks.md in <folder> has no checkboxes. Looks malformed — check the file.
```

### Lint fails with errors from OTHER specs/features

Sometimes lint failures are unrelated to the current spec (e.g., a stale type from a different feature). Report the failure but note:

```
Lint failure in src/other-feature/foo.ts may be pre-existing.
Check whether this file is touched by this spec before treating as a blocker.
```

### Deferred tests

If a test checkbox has explicit deferral annotation (e.g., `- [ ] Write scanCache.test.ts — deferred, needs HTTP mocking`), report it under "Deferrals" not "Blockers."

## Tips

- **Run all three checks even if early ones fail.** A lint failure often masks deeper issues that the build would also catch — useful to see both.
- **Report the FIRST error, not the whole stack.** The user wants the headline; they can read the full output if they want detail.
- **Don't suggest fixes here.** This command reports state. Fixes come from `/agent-os:next-task`. Mixing the two muddies the audit trail.
