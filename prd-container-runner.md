# PRD: Dragnet — Containerized Execution & Remote Scan Flow

## Problem Statement

Running Dragnet in isolated environments (e.g. Docker, VPS, LAN servers) prevents direct local filesystem access, breaking the PR review flow. Currently, deterministic checks (eslint, tsc) run directly on the host machine using standard shell execution (`execFileSync`). This approach introduces two critical problems:

1. **Security Vulnerability**: Running npm installs and tests from untrusted PR branches directly on the host machine invites Remote Code Execution (RCE) via postinstall scripts or malicious test suites.
2. **Environment Contamination & Incompatibility**: The host must have the correct Node.js versions, build tools, and system dependencies pre-installed for every target repository. Running these tools directly on the host pollutes the machine and leads to execution errors due to toolchain version mismatches.
3. **Firewall Webhook Block**: In local/private LAN setups, Git hosts cannot send webhook events to Dragnet, leaving the platform with no way to trigger scans automatically without setting up complex public tunnels.

## Solution

We will introduce a containerized orchestration architecture and remote scan triggering model:

1. **Git-Only Repository Access**: All repositories are checked out into dedicated, persistent Docker/Podman volumes rather than relying on local host directories.
2. **Ephemeral Container Sandbox**: Deterministic build, lint, and test commands are run inside isolated, resource-constrained runner containers (Docker-out-of-Docker via the host's Docker socket).
3. **Persistent Volume Caching**: The node_modules and build directories are preserved inside the persistent Docker volume between scans to allow fast incremental updates.
4. **Restricted Sandbox Environment**: The runner container runs without host environment variables, with restricted CPU/memory resources, and with a hard execution timeout to avoid resource exhaustion.
5. **Dual-Trigger Mode**: Supports incoming GitHub/GitLab webhooks (for public/VPS installs) and an active polling worker (for firewalled/local environments) to trigger scans on commit.

## User Stories

1. As a self-hosting developer, I want Dragnet to fetch repository source code exclusively via Git clones into Docker volumes, so that my local workspace is never modified by a scan and I don't suffer from uncommitted file side-effects.
2. As a DevOps engineer deploying Dragnet on a VPS, I want the server to manage clones automatically in Docker volumes, so that I do not have to map arbitrary host directory paths into my Next.js container.
3. As a project administrator, I want to configure custom container images for PR reviews, so that tests, typechecks, and linters run in the exact language/runtime version required by my application (e.g., Node 22 vs. Node 20).
4. As a security architect, I want build and test commands to run inside an isolated, unprivileged container, so that malicious PR code or compromised dependencies cannot access the Dragnet host filesystem, environment variables, or other repos.
5. As a security architect, I want runner containers to have network access disabled during the test/lint execution phase, so that malicious code cannot exfiltrate codebase secrets or database connection strings to external servers.
6. As a developer, I want Dragnet to persist node_modules and build caches on the Docker volume between runs, so that subsequent PR reviews do not spend minutes downloading packages and finish in seconds.
7. As a system administrator, I want runner containers to be constrained by CPU, memory, and a hard execution timeout, so that a hung test suite or infinite loop in a PR does not crash the host machine or exhaust its resources.
8. As a developer working on a firewalled local network, I want Dragnet to poll the Git platform (GitHub/GitLab) for new PR commits, so that I get automated reviews without having to expose my local server to the public internet using tunnels.
9. As a VPS deployment owner, I want Dragnet to receive webhook events from GitHub, so that reviews are triggered instantaneously upon push without the delay or API quota cost of polling.
10. As a developer, I want to see detailed build/test/lint execution logs in the Dragnet dashboard when a check fails, so that I can diagnose configuration errors or test regressions easily.
11. As a database administrator, I want all repository-specific volumes to be automatically pruned and deleted when a repository is deleted from Dragnet, so that the disk is not clogged with orphaned Docker volumes.

## Implementation Decisions

### 1. Volume & Workspace Orchestration
- **Named Docker Volumes**: Dragnet will manage repository files within named Docker volumes formatted as `dragnet-repo-${repositoryId}`.
- **Git Sync Service**: A background service will handle checking out code. Instead of accessing `repo.path` on the host, Dragnet will issue git commands in a tiny Git helper container or internally mount the volume. The workspace sync executes:
  `git fetch origin && git checkout -f ${commitHash} && git clean -fd`
- **Volume Lifetime**: Creation of the volume occurs on repository link. Deletion is bound to the repository delete endpoint via database cascades.

### 2. Containerized Runner Execution
- **Docker Socket Communication**: The Dragnet container requires read-write access to the host's `/var/run/docker.sock` or Podman equivalent.
- **Dynamic Container Lifecycle**: During a PR scan, Dragnet spawns a sibling container using a configured image (e.g. `node:22-alpine` or a custom python/go image).
- **Volume Mounting**: The named volume `dragnet-repo-${repositoryId}` is mounted to the container at a dedicated path (e.g. `/workspace`).
- **Resource Constraining**: Containers are started with:
  - CPU Limits (e.g., `--cpus=2`)
  - Memory Limits (e.g., `--memory=4g`)
  - Execution Timeout (implemented via `AbortController` and process signals)
- **Secret Separation**: The runner container does not inherit any system environment variables from the Dragnet server container. Sensitive variables like `DATABASE_URL` or LLM API keys are entirely omitted.

### 3. Schema & API Changes
- **Repository Model**: Update the `Repository` schema to include:
  - `runnerImage`: The Docker/Podman image to run commands in (default: `node:20-alpine` for JS/TS).
  - `installCommand`: The command to install dependencies (e.g., `npm install`).
  - `testCommand`: The command to execute tests/linters (e.g., `npm test && npm run lint`).
  - `isPollingEnabled`: Boolean to toggle the active polling worker.
- **Scan Result Logging**: Persist execution stdout/stderr logs of the runner container to the `ReviewLog` table so they are visible on the dashboard.

### 4. Integration Triggers
- **Webhook Endpoint**: Keep the `POST /api/webhooks/github` route active and secured via HMAC signature validation (`verifyGithubSignature`).
- **Active Poller**: Implement a lightweight background worker that periodically polls the Git provider APIs for new commits/PRs on active repos where `isPollingEnabled` is true.

## Testing Decisions

### 1. Testing Seams
- **ContainerOrchestrator Seam (`src/lib/containerOrchestrator.ts`)**:
  - All direct interactions with the Docker socket or command-line CLI are abstracted behind a `ContainerOrchestrator` interface.
  - In Vitest test suites, a mock version of this interface will be injected. The mock will simulate volume creation, exit codes (0 for success, non-zero for failures), timeouts, and standard output/error streams without executing real docker binaries or needing a running docker daemon.
- **GitService Seam (`src/services/gitService.ts`)**:
  - The git checkout and fetch actions are abstracted into a `GitService`. In tests, it operates on a local directory fixture, allowing us to mock checkouts of different branches and verify git-clean/fetch flows.

### 2. What Makes a Good Test
- Tests should only validate the external behavior of the orchestrator and the scan pipeline, avoiding tests for specific docker CLI string arguments.
- We must assert that a compiler or lint failure inside the runner returns the correct list of `DeterministicFinding` objects with proper mapping of error levels (error/warning).
- We must assert that runner execution timeouts or memory exhaustions do not crash the Dragnet service, but are gracefully caught, classified, and logged as system warnings.
- We must verify that no sensitive environment variables (such as `DATABASE_URL` or LLM keys) are passed in the configuration of the runner containers.

### 3. Prior Art
- `tests/providerBreakerIntegration.test.ts` for structured integration tests with mocked external systems.
- `tests/scanAbortIntegration.test.ts` for verifying handling of interrupted and aborted processes.

## Out of Scope

- **Custom Dockerfile Building**: Dragnet will not build custom Docker images on the fly. Users must specify an existing image from a registry (Docker Hub, GitHub Packages, or local daemon cache).
- **Docker-in-Docker (DinD) VM Orchestration**: Running a full VM-level container orchestrator is out of scope. We assume sibling container access on the same host daemon.
- **Custom SSH Key Management per developer**: Only repository-level Deploy Keys or Personal Access Tokens are handled.

## Further Notes

- **Volume Pruning Command**: Provide an administrative CLI command (`npm run dragnet prune-volumes`) to clean up any orphaned Docker volumes that might have survived deletion due to server crashes.
