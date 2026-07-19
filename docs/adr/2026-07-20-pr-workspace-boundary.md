# ADR: PR workspace boundary

## Status

Accepted

## Decision

The browser's active pull-request review context is a PR workspace. It owns
the selected repository and pull request, request freshness, and review-data
refresh lifecycle. Repository registration, database configuration, and the
server polling worker remain outside that workspace.

The migration introduces `usePrWorkspace` and the pure
`PrWorkspaceCoordinator`. Dashboard and PR consumers now read workspace state
and named lifecycle commands directly; the former compatibility facade and
generic forwarding contract were removed. The coordinator rejects late list
and detail responses, preventing an old repository or PR response from
overwriting a newer selection.

## Consequences

- Browser refreshes continue using the existing authenticated HTTP adapter.
- The workspace never reads the Docker-mounted filesystem directly.
- Selection and stale-response behavior can be tested without React, HTTP, or
  a database.
- Repository registration, database configuration, and activity history remain
  dashboard-owned while PR review state remains workspace-scoped.
- The production image must be rebuilt before runtime verification because the
  running container uses the pre-built image rather than a host dev server.
