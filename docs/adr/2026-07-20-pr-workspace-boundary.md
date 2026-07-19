# ADR: PR workspace boundary

## Status

Accepted

## Decision

The browser's active pull-request review context is a PR workspace. It owns
the selected repository and pull request, request freshness, and review-data
refresh lifecycle. Repository registration, database configuration, and the
server polling worker remain outside that workspace.

The first migration slice introduces `usePrWorkspace` and the pure
`PrWorkspaceCoordinator`. The existing dashboard hook remains a compatibility
facade while consumers move incrementally. The coordinator rejects late list
and detail responses, preventing an old repository or PR response from
overwriting a newer selection.

## Consequences

- Browser refreshes continue using the existing authenticated HTTP adapter.
- The workspace never reads the Docker-mounted filesystem directly.
- Selection and stale-response behavior can be tested without React, HTTP, or
  a database.
- The dashboard hook can be reduced in later slices without changing `App`'s
  current data contract.
