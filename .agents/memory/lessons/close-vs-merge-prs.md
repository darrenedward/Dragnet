# Lesson: Never close a PR — always merge it

When issue #27's checklist said "Close both PRs referencing issue numbers", I called `gh pr close` on PRs #28 and #29 without merging them. This left the feature code orphaned on feature branches with no path to `main`.

The code from those branches was never integrated. The PRs needed to be merged (squash or rebase) first, then closed only if intentionally abandoned.

**Rule:** If a PR contains working, verified code, **merge** it. Only `gh pr close` if the PR is superseded, abandoned, or the changes are intentionally discarded. "Close" in a checklist almost always means "close the loop" — i.e. ship it — not literally `gh pr close`.

**Fix applied:** Reopened both PRs, rebased onto main (PR #29 needed it due to squash history), merged both via `gh pr merge --squash`. All 1266 tests pass on the merged result.
