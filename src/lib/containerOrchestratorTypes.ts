/** Environment allowed into a containerized Git synchronization command. */
export type GitSyncRunnerEnv = {
  GIT_SSH_COMMAND?: string;
};

export interface RunOptions {
  /**
   * Named Docker volume mounted at /workspace. Required unless hostBindPath
   * is set (local-only tip tree bind-mount).
   */
  volumeName?: string;
  /**
   * Host path bind-mounted at /workspace (local-only tip worktree). When set,
   * volumeName is ignored for the mount.
   */
  hostBindPath?: string;
  image: string;
  commands: string[]; // e.g. ["npm install", "npm test"]
  timeoutMs?: number;
  memoryLimit?: string; // e.g. "4g"
  cpuLimit?: string; // e.g. "2"
  /** Only Git synchronization may pass its scoped SSH command. */
  env?: GitSyncRunnerEnv;
  /** Docker network mode. Defaults to "none" (no network). Set to "bridge"
   *  for git operations that need outbound network access. */
  networkMode?: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
