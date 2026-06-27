# Write Tasks

Generate `tasks.md` from `plan.md` for an existing spec. Reads the plan's task structure and emits a phase-grouped checkbox list following the project convention.

## Important Guidelines

- **Mirror the plan, don't editorialize.** Every checkbox must trace back to a documented task in `plan.md`. If the plan is vague, the checkbox is vague — don't silently invent detail.
- **Phase grouping comes from the plan's `## Task N:` structure.** One phase per plan task, in order.
- **Phase 1 is always "Spec documentation"** and its first item is always `- [x] Create .agent-os/specs/<folder>/ with plan.md, shape.md, standards.md, references.md, tasks.md.` (already done — that's why we're writing tasks.md).
- **`- [ ]` only.** Never pre-check implementation items.
- **Keep each checkbox to one line.** Multi-line context goes in `plan.md`, not `tasks.md`.

## Process

### Step 1: Resolve the spec folder

If the user passed a spec folder name (`/agent-os:write-tasks 2026-06-27-large-pr-mode`), use it.

Otherwise, list `.agent-os/specs/` and use AskUserQuestion to pick.

If the spec folder doesn't have a `plan.md`, stop and tell the user:

```
No plan.md found in <folder>. Run /agent-os:shape-spec first to create the plan.
```

### Step 2: Read plan.md and extract tasks

Read `.agent-os/specs/<folder>/plan.md`. Parse the task structure:

- Each `## Task N: <title>` heading starts a new phase.
- The body under each heading contains the work: file paths, code blocks, "Verify:" steps.
- Bullet lists under each task become checkboxes.

For each task, extract:
- **Phase name** — derived from the task heading (e.g., `## Task 3: Schema — ReviewChunk model` → `Phase 3 — Schema (ReviewChunk model)`).
- **Checkboxes** — one per discrete piece of work. Common patterns:
  - File creation: `Create <path> exporting <symbols>.`
  - File modification: `Add <field/parameter> to <path>:<line>.`
  - Behavior: `<verb> <what> <where>.`
  - Verification: `npm run lint clean.` / `npm test — existing tests pass.`
  - Tests: `Write <test file> — <what it tests>.`

### Step 3: Build the tasks.md content

Use this exact structure:

```markdown
# Tasks — <Spec Name>

Mark each `- [ ]` as `- [x]` when complete. Per user convention: update this file as work ships, one commit per phase.

## Phase 1 — Spec documentation

- [x] Create `.agent-os/specs/<folder>/` with plan.md, shape.md, standards.md, references.md, tasks.md.

## Phase 2 — <name>

- [ ] <first sub-task from plan task 2>.
- [ ] <second sub-task>.
- [ ] `npm run lint` clean.

## Phase 3 — <name>

- [ ] ...

...

## Phase N — Tests + final verification

- [ ] `npm run lint` clean.
- [ ] `npm test` — all existing tests + new tests pass.
- [ ] `npm run build` — production build succeeds.
- [ ] Manual: <any manual verification steps from the plan>.
```

### Conventions to follow

- **Phase headers**: `## Phase N — <name>` (em dash, not hyphen).
- **Checkbox style**: `- [ ]` with a trailing period.
- **File paths in backticks**: `` `src/services/foo.ts` ``, `` `prisma/schema.prisma` ``.
- **Commands in backticks**: `` `npm run lint` ``, `` `npx prisma db push` ``.
- **Bold prefix for emphasis**: `**2a:**` when a plan task uses letter-suffixed sub-task IDs.
- **Manual steps**: prefix with `Manual: ` so `verify-spec` knows to skip them.

### Step 4: Write tasks.md

Write the generated content to `.agent-os/specs/<folder>/tasks.md`.

If `tasks.md` already exists, ask before overwriting:

```
tasks.md already exists in <folder> with <N> checkboxes (<M> done).

Overwrite, or append the new phases?
```

Usually the answer is overwrite (the existing file was a stub). But if there's real progress, append instead.

### Step 5: Report

```
✓ tasks.md written.

Phases: <N>
Total checkboxes: <M>
Estimated commits: ~<M> (one per task)

Next: run /agent-os:next-task <folder> to start implementing.
```

## Edge cases

### Vague plan task

If a plan task is `## Task 4: Make it faster` with no body, the generated checkbox is:

```markdown
- [ ] Make it faster (per plan Task 4 — details TBD).
```

Don't invent sub-tasks. Flag it for the user to expand the plan first.

### Plan with no task headings

If `plan.md` doesn't use `## Task N:` structure (some specs use `## Phase N:` directly), parse whichever structure is present. Emit one checkbox per actionable bullet.

### Plan references a different spec

Sometimes a plan says "follow the pattern from `<other-spec>/plan.md`.`" Add a single checkbox referencing both:

```markdown
- [ ] Implement <thing> per `<other-spec>/plan.md` Task N.
```

## Tips

- **Don't add verification checkboxes the plan didn't ask for.** If a plan task doesn't end with a `Verify:` step, don't insert `npm run lint clean` — that's invention.
- **Group related sub-bullets.** If a plan task lists 5 file modifications, those are 5 checkboxes, not 1.
- **End-of-phase lint checks ARE worth keeping.** Even if the plan doesn't explicitly say so, every implementation phase should end with `npm run lint clean` — it's the project invariant.
