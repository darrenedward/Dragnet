import { execFile as cpExecFile, spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { type RunOptions, type RunResult } from "./containerOrchestratorTypes";

function asyncExecFile(file: string, args: string[], options: { encoding: string; signal: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    cpExecFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}

function asyncSpawnWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let didTimeout = false;

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      stdout += data;
    });

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (data: string) => {
      stderr += data;
    });

    const timer = setTimeout(() => {
      didTimeout = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (didTimeout) {
        const err = new Error("timed out") as Error & Record<string, unknown>;
        err.name = "AbortError";
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else if (exitCode !== 0 && exitCode !== null) {
        const err = new Error(`Process exited with code ${exitCode}`) as Error & Record<string, unknown>;
        err.exitCode = exitCode;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

let cachedEngine: "docker" | "podman" | null = null;
const ALLOWED_RUNNER_ENV_KEYS = new Set(["GIT_SSH_COMMAND"]);
export const SYNTHETIC_DATABASE_URL =
  "postgresql://dragnet-quality-check:dragnet-quality-check@127.0.0.1:5432/placeholder";

/**
 * Detects whether docker or podman is installed and available.
 * Defaults to "docker" if both or neither are found (using system commands).
 */
export function detectContainerEngine(): "docker" | "podman" {
  if (process.env.CONTAINER_RUNTIME === "podman") return "podman";
  if (process.env.CONTAINER_RUNTIME === "docker") return "docker";
  if (cachedEngine) return cachedEngine;

  try {
    execSync("podman --version", { stdio: "ignore" });
    cachedEngine = "podman";
  } catch {
    cachedEngine = "docker";
  }
  return cachedEngine;
}

export class ContainerOrchestrator {
  private static instance: ContainerOrchestrator | null = null;

  public static getInstance(): ContainerOrchestrator {
    if (!ContainerOrchestrator.instance) {
      ContainerOrchestrator.instance = new ContainerOrchestrator();
    }
    return ContainerOrchestrator.instance;
  }

  /**
   * Sets a custom orchestrator instance (useful for Vitest mocking).
   */
  public static setInstance(mockInstance: ContainerOrchestrator): void {
    ContainerOrchestrator.instance = mockInstance;
  }

  /**
   * Creates a dedicated named volume for a repository.
   */
  public async createVolume(volumeName: string): Promise<void> {
    const engine = detectContainerEngine();
    try {
      await asyncExecFile(engine, ["volume", "create", volumeName], {
        encoding: "utf8",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw new Error(`Failed to create volume ${volumeName} via ${engine}: ${err.message}`);
    }
  }

  /**
   * Deletes a named volume.
   */
  public async deleteVolume(volumeName: string): Promise<void> {
    const engine = detectContainerEngine();
    try {
      await asyncExecFile(engine, ["volume", "rm", "-f", volumeName], {
        encoding: "utf8",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      throw new Error(`Failed to delete volume ${volumeName} via ${engine}: ${err.message}`);
    }
  }

  /**
   * Spawns an ephemeral container with the repository volume mounted,
   * runs the build/test/lint commands, and returns the exit code and logs.
   */
  public async runRunner(options: RunOptions): Promise<RunResult> {
    const engine = detectContainerEngine();
    const timeoutMs = options.timeoutMs ?? 300_000; // default 5 minutes
    // CPU/memory limits are opt-in, not hardcoded:
    //   - unset / "0"  → no flag (use host capacity — required on 1-vCPU VPS)
    //   - "1", "2"...  → --cpus N
    //   - "512m", "2g" → --memory <limit>
    // Hardcoded --cpus 2 breaks Dokploy 1-CPU hosts (Docker exit 125).
    const memoryLimit = options.memoryLimit ?? process.env.DRAGNET_RUNNER_MEMORY;
    const cpuLimit = options.cpuLimit ?? process.env.DRAGNET_RUNNER_CPUS;

    // Build docker/podman run arguments
    const networkMode = options.networkMode ?? "none";
    const args = ["run", "--rm", "--network", networkMode];
    if (memoryLimit && memoryLimit !== "0") args.push("--memory", memoryLimit);
    if (cpuLimit && cpuLimit !== "0") args.push("--cpus", cpuLimit);
    const mountSource = options.hostBindPath
      ? options.hostBindPath
      : options.volumeName;
    if (!mountSource) {
      throw new Error("runRunner requires volumeName or hostBindPath");
    }
    args.push(
      "-v",
      `${mountSource}:/workspace:rw`,
      "-w",
      "/workspace",
    );

    // Add minimal safe environment variables (e.g. clean PATH)
    args.push("-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");

    // Add custom env vars if provided (ensuring system secrets aren't passed)
    if (options.env) {
      for (const [key, val] of Object.entries(options.env)) {
        if (!ALLOWED_RUNNER_ENV_KEYS.has(key)) continue;
        args.push("-e", `${key}=${val}`);
      }
    }
    if (options.provideSyntheticDatabaseUrl) {
      args.push("-e", `DATABASE_URL=${SYNTHETIC_DATABASE_URL}`);
    }

    // Override entrypoint to sh — images like alpine/git have git as
    // their ENTRYPOINT, which would turn `sh -c "..."` into
    // `git sh -c "..."` and fail. The shell script handles everything.
    args.push("--entrypoint", "sh");
    args.push(options.image);

    // Combine commands into a single shell execution
    // e.g. sh -c "npm install && npm test"
    const shellScript = options.commands.join(" && ");
    args.push("-c", shellScript);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let timedOut = false;

    try {
      const result = await asyncSpawnWithTimeout(engine, args, timeoutMs);
      stdout = result.stdout;
    } catch (err: any) {
      if (err.name === "AbortError") {
        timedOut = true;
        exitCode = -1;
        stdout = err.stdout ?? "";
        stderr = (err.stderr ?? "") + `\nCommand execution timed out after ${timeoutMs / 1000}s`;
      } else {
        exitCode = err.exitCode ?? -1;
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? err.message ?? "";
      }
    }

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
    };
  }

  /**
   * Copies the contents of a Docker volume to a host directory using a
   * tar pipe. Creates hostDir if it doesn't exist.
   *
   * Uses a tar pipe instead of `cp -a` with a bind mount because the bind
   * mount path resolves on the HOST filesystem, not the Dragnet container's
   * filesystem. The tar pipe writes data through stdout so files land in
   * the Dragnet container with the correct ownership.
   *
   * Uses `alpine/git` (already pulled for git operations) by default.
   */
  public async copyVolumeToHost(
    volumeName: string,
    hostDir: string,
    image: string = "alpine/git",
  ): Promise<void> {
    const engine = detectContainerEngine();
    mkdirSync(hostDir, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const dockerProc = spawn(engine, [
          "run", "--rm",
          "-v", `${volumeName}:/src:ro`,
          "--entrypoint", "sh",
          image,
          "-c", "tar cf - -C /src .",
        ], { stdio: ["ignore", "pipe", "pipe"] });

        const tarProc = spawn("tar", ["xf", "-", "-C", hostDir], {
          stdio: ["pipe", "inherit", "inherit"],
        });

        dockerProc.stdout!.pipe(tarProc.stdin!);

        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        dockerProc.on("error", (err) => {
          tarProc.kill();
          settle(new Error(`docker run failed: ${err.message}`));
        });

        tarProc.on("error", (err) => {
          dockerProc.kill();
          settle(new Error(`tar extraction failed: ${err.message}`));
        });

        tarProc.on("close", (code) => {
          if (code === 0) settle();
          else settle(new Error(`tar extraction exited with code ${code}`));
        });
      });
    } catch (err: any) {
      throw new Error(
        `Failed to copy volume ${volumeName} to ${hostDir} via ${engine}: ${err.message}`,
      );
    }
  }
}
