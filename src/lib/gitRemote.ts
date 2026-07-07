/**
 * @deprecated Containerized git operations now use `ContainerOrchestrator` +
 * `gitService.buildSshEnv` instead. All callers have been migrated to
 * `remoteFetchWorker` (ContainerOrchestrator) and `gitService` (buildSshEnv).
 * This file remains for reference only and will be removed in a future PR.
 *
 * To clone/fetch a remote repo, use `ContainerOrchestrator.runRunner()` with
 * an `alpine/git` sidecar. To build SSH env for deploy keys, use
 * `buildSshEnv()` from `./gitService`.
 */

export { buildSshEnv } from "./gitService";
