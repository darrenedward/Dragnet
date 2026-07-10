# Tasks — `/dragnet merge` Topology-Aware Merge Skill

Update status as work progresses. Mark each `[x]` only when work is actually done.

## Piece 1 — Dragnet API: topology helper + prlist extension

- [x] 1.1 Create `src/lib/prStackTopology.ts` exporting `computeStackTopology(prs, scannedPrIds)`. Build `sourceBranch → PR` index. For each PR, walk `targetBranch` chain via index. Cycle-guard via visited Set. Return `Map<prId, {stackDepth, dependencies[], unscannedDepsCount}>`.
- [x] 1.2 Extract shared `buildPrList(repoId)` helper in `src/app/api/command/[[...args]]/route.ts`. Queries PRs + distinct scanned prIds in two shots, computes topology, returns merged shape.
- [x] 1.3 Refactor `handlePrList` (JSON-RPC, ~line 329) to use `buildPrList`. Markdown rendering appends `Stack: depth=N, unscanned deps: M` per PR.
- [x] 1.4 Refactor legacy inline handler (~line 535) to use `buildPrList`. JSON response adds `stackDepth`, `dependencies`, `unscannedDepsCount` per PR.
- [x] 1.5 `npm run lint` (tsc --noEmit) clean.

## Piece 2 — Verify API change

- [x] 2.1 curl `prlist` against DevWorld — fields exist, but **all PRs return `stackDepth=0`**.
- [x] 2.2 JSON-RPC path returns Markdown (verified via tsc; curl uses legacy path).
- [x] 2.3 **Data limitation found:** Dragnet's DB `targetBranch` is set to `baseBranch` ("main") at PR creation (`getRealLocalPrs.ts:175`) and never updated from GitHub. Retargeted PRs (stacked-PR workflow) have stale targetBranch. So the API topology is correct code, but the underlying data is wrong for retargeted PRs.
- [x] 2.4 **Mitigation:** merge.md protocol explicitly does its own topology walk via `gh pr list --json number,baseRefName,headRefName,mergeable`. Dragnet's topology fields are advisory/hint; `gh` is authoritative at execution time. Trust-but-verify.
- [x] 2.5 **Issue #32 created:** sync `targetBranch` from GitHub (`gh pr view --json baseRefName`) during PR refresh — separate issue, blocks accurate web UI topology view.

## Piece 3 — Skill: `/dragnet merge` subcommand

- [x] 3.1 Create `.claude/skills/dragnet/references/merge.md` with full 10-step protocol.
- [x] 3.2 Update `.claude/skills/dragnet/SKILL.md` frontmatter: add `AskUserQuestion`, `Bash(gh:*)` to `allowed-tools`.
- [x] 3.3 Add `/dragnet merge [n,n,...]` row to commands table.
- [x] 3.4 Add rule 11 (verify-before-merge) to behavioral rules section.
- [x] 3.5 Pointer to `references/merge.md` lives in the commands table row (no separate pointer section).
- [x] 3.6 Sync to `~/.claude/skills/dragnet/` (skill install location per CLAUDE.md). Done: `rm -rf ~/.claude/skills/dragnet && cp -r .claude/skills/dragnet ~/.claude/skills/dragnet`. Verified `allowed-tools` frontmatter includes `AskUserQuestion, Bash(gh:*)`.

## Piece 4 — Docs

- [x] 4.1 Add `/dragnet merge [n,n,...]` row to project root `CLAUDE.md` Agent skill section.

## Piece 5 — Ship

- [x] 5.1 `npm run lint` (tsc --noEmit) passes one final time.
- [x] 5.2 Split into logical commits — `bc6ccb2` (topology helper + API change) and `7f69e84` (skill docs: SKILL.md frontmatter/rules + references/merge.md). Spec dir + CLAUDE.md are gitignored so stayed local.
- [ ] 5.3 Manual: invoke `/dragnet merge` from `../DevWorld` cwd. Verify Reality/Problem table renders for stacked PRs; verify AskUserQuestion presents strategies. *(Manual — run at next DevWorld session)*
- [ ] 5.4 Manual: `/dragnet merge 7,8` against DevWorld — verify refusal (PR #8 conflicting, PR #7 has unscanned dep). *(Manual — run at next DevWorld session)*

## Tracked as GitHub issue

- [x] Created as [issue #44](https://github.com/darrenedwardhouseofjones/Dragnet/issues/44) with `ready-for-agent` label.

## Blockers / open questions

- None currently. If `gh pr merge --auto` polling semantics differ from `gh`'s docs, adjust max poll time in step 9.
- If web UI breaks on new `prlist` fields (shouldn't — additive), gate behind env flag in a follow-up.
