export interface RunOptions {
  volumeName: string;
  image: string;
  commands: string[]; // e.g. ["npm install", "npm test"]
  timeoutMs?: number;
  memoryLimit?: string; // e.g. "4g"
  cpuLimit?: string; // e.g. "2"
  env?: Record<string, string>;
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
