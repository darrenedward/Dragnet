# PR workspace specification

## Problem Statement

The dashboard hook currently combines repository registration, database
configuration, activity history, pull-request selection, review-data loading,
scan lifecycle commands, and presentation feedback. This makes the active PR
review context difficult to reason about and difficult to test. A late response
from a previous repository or PR can also overwrite the user's current view.

The user needs a coherent PR workspace that keeps the selected repository,
selected pull request, files, findings, review progress, and recoverable scan
state together, while leaving setup and repository-catalog concerns outside the
active review context.

## Solution

Introduce a browser-facing PR workspace module with a pure request-freshness
boundary and a React adapter. The workspace exposes named commands for
selection, refresh, scan lifecycle, interrupted-scan recovery, export, and
copy feedback. It uses the existing authenticated browser transport and the
existing server endpoints.

The migration is complete. `useDashboardData` now exposes the PR workspace
read model and named commands directly alongside repository catalog and setup
operations; there is no second compatibility contract for `App` to consume.

## User Stories

1. As a reviewer, I want the selected repository and pull request to form one
   coherent workspace, so that every visible file, finding, and progress state
   belongs to the review I am examining.
2. As a reviewer, I want switching repositories to clear the previous PR
   selection, so that stale review content is not shown under a new project.
3. As a reviewer, I want switching pull requests to clear transient scan
   feedback, so that a success, interruption, or skip message cannot appear on
   the wrong PR.
4. As a reviewer, I want a late response from an old repository selection to be
   ignored, so that a slow network response cannot move me back to an old
   project.
5. As a reviewer, I want a late response from an old PR selection to be
   ignored, so that files and findings remain aligned with the current PR.
6. As a reviewer, I want the last good files and findings to remain visible
   while a refresh is in flight, so that polling does not make the report flash
   empty.
7. As a reviewer, I want a recoverable refresh error state, so that I know the
   displayed snapshot may be stale without losing the evidence already loaded.
8. As a reviewer, I want background refresh to reflect server-side scan
   progress, so that the UI updates when a daemon, hook, or another client
   starts a scan.
9. As a reviewer, I want browser polling to refresh display state only, so that
   viewing the dashboard never starts duplicate scans.
10. As a reviewer, I want to start a review for the selected PR, so that the
    scan lifecycle belongs to the workspace I am looking at.
11. As a reviewer, I want the optimistic scanning state to remain scoped to the
    PR that was started, so that changing PRs does not leak a spinner or disable
    controls on another PR.
12. As a reviewer, I want to stop an active scan, so that I can recover from a
    run that should no longer continue.
13. As a reviewer, I want to continue an interrupted scan when its checkpoint
    is still valid, so that completed work is not needlessly replayed.
14. As a reviewer, I want resume to be rejected clearly when code or review
    configuration changed, so that I can start a fresh scan knowingly.
15. As a reviewer, I want to discard an interrupted checkpoint and start fresh,
    so that a stale partial run cannot block current review work.
16. As a reviewer, I want to retry failed large-PR chunks, so that recoverable
    chunk failures do not require restarting the entire review.
17. As a reviewer, I want to export the completed review as a file or download,
    so that the report can be retained outside the dashboard.
18. As a reviewer, I want copy feedback to be scoped to the active workspace,
    so that transient UI feedback stays understandable.
19. As a repository administrator, I want repository registration and GitHub
    credentials to remain outside the PR workspace, so that setup actions do
    not unexpectedly change the review I am viewing.
20. As a database administrator, I want database configuration to remain
    outside the PR workspace, so that infrastructure setup does not become part
    of review-state transitions.
21. As a server operator, I want the server polling worker to remain separate
    from browser refresh, so that daemon discovery and scan admission retain
    their existing ownership and concurrency rules.
22. As a developer, I want workspace selection and freshness behavior tested
    without React, HTTP, or a database, so that race conditions can be verified
    deterministically.
23. As a developer, I want the existing dashboard consumer contract preserved
    during migration, so that each extraction slice can remain green.
24. As a developer, I want direct state setters replaced by named workspace
    commands, so that selection and lifecycle transitions have one semantic
    entry point.
25. As a contributor, I want the workspace module split into focused files
    under the repository size limit, so that the design remains navigable.

## Implementation Decisions

- The canonical domain term is **PR workspace**. It is not a dashboard
  snapshot, repository catalog, or database setup session.
- The workspace owns the selected repository, selected pull request, files,
  findings, completed review run, active scan, queue state, interrupted-scan
  metadata, scan feedback, and refresh freshness.
- Repository catalog loading, repository registration, database configuration,
  and activity history remain outside the workspace.
- The browser-facing API is a React hook named `usePrWorkspace`; pure
  request/selection coordination sits behind it as a testable module.
- Browser transport remains the existing authenticated `fetchJson` adapter.
  Tests use an in-memory adapter or pure coordinator rather than Docker,
  mounted files, or a live database.
- Server endpoints remain unchanged in this migration.
- Browser polling refreshes the selected repository and PR display state only.
  It does not trigger scans. Server-side polling remains responsible for
  discovery and scan admission.
- Workspace commands are named operations such as select repository, select
  pull request, refresh, start scan, stop scan, continue, start fresh, retry
  failed chunks, and export. New consumers should not depend on unscoped
  setters for lifecycle transitions.
- Every list or detail request carries a freshness token tied to its selection.
  Responses that are no longer current are ignored.
- Refresh failures preserve the last good snapshot and expose a stale or
  recoverable error state.
- Scan state is scoped by PR ID. Optimistic state may protect an in-flight
  request but must not appear on a different selected PR.
- The dashboard and PR views consume the workspace read model and named
  commands directly. Repository registration, database configuration, and
  activity history remain dashboard-owned.
- The workspace hook, pure coordinator, race-condition tests, lifecycle
  commands, and consumer migration are complete. Runtime verification rebuilds
  the production container before probing it.

## Testing Decisions

- Tests verify externally observable workspace behavior, not React internals
  or implementation-specific state layout.
- The pure coordinator is the first seam and covers late PR-list responses,
  late detail responses, selection retention, and empty-list clearing.
- The workspace read model must cover switching PRs while refresh is in flight,
  preserving the last good snapshot on refresh failure, and auto-refreshing
  server scan progress.
- Scan lifecycle tests must cover start, stop, interrupted-to-continue,
  interrupted-to-start-fresh, resume rejection after code/config drift, and
  failed-chunk retry.
- Authentication behavior must retain the existing 401 redirect to the login
  page.
- Existing API and polling tests remain the regression baseline. Container
  verification is required for production behavior because the running server
  uses a rebuilt Docker image rather than a host development server.

## Out of Scope

- Changing server API routes or scan admission semantics.
- Moving the server polling worker into browser code.
- Direct browser access to the Docker-mounted filesystem.
- Redesigning repository registration, GitHub credential storage, or database
  configuration.
- Replacing the existing authenticated transport.
- Adding new review providers, scan algorithms, or database schema changes.
- Keeping a compatibility facade or unscoped PR lifecycle setters after the
  consumer migration.

## Further Notes

The dependency-ordered implementation tickets should begin with the existing
coordinator seam, then move the PR workspace read model, then scan lifecycle
commands, and finally migrate consumers and remove the compatibility facade.
Each ticket should remain demoable and keep the production container and test
suite green.
