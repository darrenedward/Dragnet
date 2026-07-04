import { execFile as cpExecFile, execSync } from "node:child_process";
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

let cachedEngine: "docker" | "podman" | null = null;

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
    const memoryLimit = options.memoryLimit ?? "4g";
    const cpuLimit = options.cpuLimit ?? "2";

    // Build docker/podman run arguments
    const networkMode = options.networkMode ?? "none";
    const args = [
      "run",
      "--rm",
      "--network",
      networkMode,
      "--memory",
      memoryLimit,
      "--cpus",
      cpuLimit,
      "-v",
      `${options.volumeName}:/workspace:rw`,
      "-w",
      "/workspace",
    ];

    // Add minimal safe environment variables (e.g. clean PATH)
    args.push("-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");

    // Add custom env vars if provided (ensuring system secrets aren't passed)
    if (options.env) {
      for (const [key, val] of Object.entries(options.env)) {
        args.push("-e", `${key}=${val}`);
      }
    }

    args.push(options.image);

    // Combine commands into a single shell execution
    // e.g. sh -c "npm install && npm test"
    const shellScript = options.commands.join(" && ");
    args.push("sh", "-c", shellScript);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let timedOut = false;

    try {
      const { stdout: out } = await asyncExecFile(engine, args, {
        encoding: "utf8",
        signal: AbortSignal.timeout(timeoutMs),
      }) as { stdout: string; stderr: string };
      stdout = out;
    } catch (err: any) {
      if (err.name === "AbortError") {
        timedOut = true;
        exitCode = -1;
        stderr = `Command execution timed out after ${timeoutMs / 1000}s`;
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
}
