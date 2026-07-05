import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContainerOrchestrator } from "../src/lib/containerOrchestrator";
import { type RunOptions } from "../src/lib/containerOrchestratorTypes";

/**
 * ContainerOrchestrator Unit Tests
 *
 * These tests validate the EXTERNAL behaviour of the ContainerOrchestrator
 * interface only — they never run a real Docker daemon. All execFile and
 * execSync calls are fully mocked.
 *
 * Prior art: tests/providerBreakerIntegration.test.ts (mocked external
 * system pattern), tests/scanAbortIntegration.test.ts (process abort
 * behaviour).
 */

// Mock child_process so no real Docker binary is called.
const mockExecFile = vi.fn<(file: string, args: string[], opts: object, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => void>();
const mockSpawn = vi.fn<(file: string, args: string[], opts: object) => ReturnType<typeof createMockSpawnProcess>>();

function createMockSpawnProcess(options?: {
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  signal: string | null;
  /** Don't auto-emit close; kill() triggers it instead */
  hangOnTimeout?: boolean;
}) {
  const dataListeners: Array<{ stream: "stdout" | "stderr"; handler: (chunk: string) => void }> = [];
  const closeListeners: Array<(...args: any[]) => void> = [];
  const errorListeners: Array<(...args: any[]) => void> = [];

  const child = {
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((event: string, handler: (chunk: string) => void) => {
        if (event === "data") dataListeners.push({ stream: "stdout", handler });
        return child.stdout;
      }),
    },
    stderr: {
      setEncoding: vi.fn(),
      on: vi.fn((event: string, handler: (chunk: string) => void) => {
        if (event === "data") dataListeners.push({ stream: "stderr", handler });
        return child.stderr;
      }),
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (event === "close") closeListeners.push(handler);
      if (event === "error") errorListeners.push(handler);
      return child;
    }),
    kill: vi.fn(() => {
      // Simulate SIGTERM → process exits with signal
      for (const h of closeListeners) h(null, "SIGTERM");
    }),
  };

  setTimeout(() => {
    if (options?.stdout) {
      for (const dl of dataListeners) {
        if (dl.stream === "stdout") dl.handler(options.stdout!);
      }
    }
    if (options?.stderr) {
      for (const dl of dataListeners) {
        if (dl.stream === "stderr") dl.handler(options.stderr!);
      }
    }
    if (!options?.hangOnTimeout) {
      const code = options?.exitCode ?? 0;
      const sig = options?.signal ?? null;
      for (const h of closeListeners) h(code, sig);
    }
  }, 0);

  return child;
}

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(args[0] as string, args[1] as string[], args[2] as object, args[3] as (err: Error | null, stdout?: string, stderr?: string) => void),
  spawn: (...args: unknown[]) => {
    const child = mockSpawn(args[0] as string, args[1] as string[], args[2] as object);
    // If mockSpawn didn't return a pre-built child, build a default one
    return child ?? createMockSpawnProcess({ exitCode: 0, signal: null });
  },
  execSync: vi.fn(),
}));

// Reset to a fresh singleton per test.
beforeEach(() => {
  ContainerOrchestrator["instance"] = null;
  mockExecFile.mockReset();
  mockSpawn.mockReset();
});

afterEach(() => {
  ContainerOrchestrator["instance"] = null;
});

describe("ContainerOrchestrator.createVolume", () => {
  it("calls the container engine with volume create", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.createVolume("dragnet-repo-test-123");
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringMatching(/docker|podman/),
      ["volume", "create", "dragnet-repo-test-123"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function),
    );
    const opts = mockExecFile.mock.calls[0][2] as { signal: unknown };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a descriptive error on failure", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(new Error("daemon not running"));
    });
    const orc = ContainerOrchestrator.getInstance();
    await expect(orc.createVolume("dragnet-repo-fail")).rejects.toThrow(
      /Failed to create volume/,
    );
  });
});

describe("ContainerOrchestrator.deleteVolume", () => {
  it("calls volume rm -f", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.deleteVolume("dragnet-repo-test-123");
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringMatching(/docker|podman/),
      ["volume", "rm", "-f", "dragnet-repo-test-123"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function),
    );
    const opts = mockExecFile.mock.calls[0][2] as { signal: unknown };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ContainerOrchestrator.runRunner", () => {
  const baseOpts: RunOptions = {
    volumeName: "dragnet-repo-abc",
    image: "node:22-alpine",
    commands: ["npm install", "npm test"],
    timeoutMs: 5000,
  };

  function mockSpawnSuccess(stdout: string) {
    mockSpawn.mockReturnValue(
      createMockSpawnProcess({ stdout, stderr: "", exitCode: 0, signal: null }),
    );
  }

  function mockSpawnFailure(opts: { exitCode: number; stdout: string; stderr: string }) {
    mockSpawn.mockReturnValue(
      createMockSpawnProcess({ ...opts, signal: null }),
    );
  }

  it("returns exitCode 0 and captured stdout on success", async () => {
    mockSpawnSuccess("Tests passed!\n");
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner(baseOpts);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Tests passed!\n");
    expect(result.timedOut).toBe(false);
  });

  it("mounts the volume at /workspace", async () => {
    mockSpawnSuccess("");
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("-v");
    const vIndex = args.indexOf("-v");
    expect(args[vIndex + 1]).toMatch(/dragnet-repo-abc:\/workspace/);
  });

  it("runs the combined shell command via sh -c", async () => {
    mockSpawnSuccess("");
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    // Last three args should be: sh -c "npm install && npm test"
    expect(args.slice(-3)).toEqual([
      "sh",
      "-c",
      "npm install && npm test",
    ]);
  });

  it("does NOT pass host environment variables to the runner", async () => {
    process.env.DATABASE_URL = "postgresql://secret@localhost/db";
    mockSpawnSuccess("");
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    // spawn third arg is the options object — env must not be there
    const callArgs = mockSpawn.mock.calls[0];
    const opts = callArgs[2] as Record<string, unknown>;
    expect(opts?.env).toBeUndefined();
    delete process.env.DATABASE_URL;
  });

  it("returns timedOut=true and exitCode=-1 on timeout", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnProcess({
        stdout: "partial build output\n",
        stderr: "still compiling...\n",
        exitCode: null,
        signal: null,
        hangOnTimeout: true,
      }),
    );
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner({ ...baseOpts, timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it("preserves partial stdout/stderr on timeout", async () => {
    mockSpawn.mockReturnValue(
      createMockSpawnProcess({
        stdout: "Tests started...\nTest 1 passed\nTest 2 running...",
        stderr: "warning: deprecated API used\n",
        exitCode: null,
        signal: null,
        hangOnTimeout: true,
      }),
    );
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner({ ...baseOpts, timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("Tests started...\nTest 1 passed\nTest 2 running...");
    expect(result.stderr).toContain("warning: deprecated API used");
    expect(result.stderr).toContain("timed out after");
  });

  it("captures stderr and non-zero exit code on failure", async () => {
    mockSpawnFailure({
      exitCode: 2,
      stdout: "",
      stderr: "error TS2322: Type mismatch\n",
    });
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner(baseOpts);
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("TS2322");
  });

  it("disables networking (--network none)", async () => {
    mockSpawnSuccess("");
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    const netIdx = args.indexOf("--network");
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe("none");
  });

  it("applies CPU and memory limits", async () => {
    mockSpawnSuccess("");
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner({ ...baseOpts, cpuLimit: "1", memoryLimit: "2g" });
    const args: string[] = mockSpawn.mock.calls[0][1] as string[];
    const cpuIdx = args.indexOf("--cpus");
    const memIdx = args.indexOf("--memory");
    expect(args[cpuIdx + 1]).toBe("1");
    expect(args[memIdx + 1]).toBe("2g");
  });
});
