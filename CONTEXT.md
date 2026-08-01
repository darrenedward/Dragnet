<p align="center">
  <img src="./public/dragnet-social-cropped.jpg" alt="Dragnet — self-hosted AI code review" width="100%">
</p>

# Dragnet Context

## PR workspace

The PR workspace is the user's current working context for examining one pull request. It includes the selected repository and pull request, the files and findings under review, and the current review progress and scan status.

The PR workspace is distinct from repository registration and database configuration. Those are setup concerns outside the user's active review context.

## Pipeline vocabulary

- **Scan finished** — a review run reached a terminal completed state. Not permission to merge.
- **Merge ready** — shared `isMergeReady` gate passed (rating ≥ 8, not skipped, reliability complete/absent, not refused, not stale vs tip). Used by prepush, findings, `/dragnet merge`, and the PR header.
- **Blocked** — a named prelude/gate refused work (clone, index, config, diff, …). UI: `Blocked at {gate}`.
- **Not ready** — scan finished or missing but merge gate failed, with a reason.
- **Stale / tip mismatch** — completed run does not match the current PR tip commit and/or diff. Header chips: rating may show `tip stale`; merge chip shows `tip mismatch` or `stale review`. Banner: `Tip mismatch` / `Review out of date`. Merge ready stays false until re-scan.
- **Tip identity** — head SHA (PR tip) + base SHA (target branch tip) that pin a scan. Repo base index alone is not enough for PR review; tools must read tip context.
- **Explicit admit** — UI Run/Force, `/dragnet` prcheck, prepush always enqueue (or join in-flight). Independent of auto-rescan.
- **AFK auto-rescan** — webhook/poller/hosted paths only; gated by auto-rescan policy.

Glanceable header chips on the PR view: status · size · webhook · cloned · indexed · rating · merge.
Internal pipeline seams (clone · webhook · index · checks · rating) still feed those chips; checks/reliability detail lives in the merge tooltip, not a second badge row. Stale/tip-mismatch uses the same chip/banner patterns (no separate panel).
