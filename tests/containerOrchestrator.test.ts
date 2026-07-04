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
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(args[0] as string, args[1] as string[], args[2] as object, args[3] as (err: Error | null, stdout?: string, stderr?: string) => void),
  execSync: vi.fn(),
}));

// Reset to a fresh singleton per test.
beforeEach(() => {
  ContainerOrchestrator["instance"] = null;
  mockExecFile.mockReset();
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

  it("returns exitCode 0 and captured stdout on success", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "Tests passed!\n", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner(baseOpts);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Tests passed!\n");
    expect(result.timedOut).toBe(false);
  });

  it("mounts the volume at /workspace", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-v");
    const vIndex = args.indexOf("-v");
    expect(args[vIndex + 1]).toMatch(/dragnet-repo-abc:\/workspace/);
  });

  it("runs the combined shell command via sh -c", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockExecFile.mock.calls[0][1] as string[];
    // Last three args should be: sh -c "npm install && npm test"
    expect(args.slice(-3)).toEqual([
      "sh",
      "-c",
      "npm install && npm test",
    ]);
  });

  it("does NOT pass host environment variables to the runner", async () => {
    process.env.DATABASE_URL = "postgresql://secret@localhost/db";
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    // Check that process.env is NOT passed to execFile — opts object should not include env
    const callArgs = mockExecFile.mock.calls[0];
    const opts = callArgs[2] as Record<string, unknown>;
    expect(opts?.env).toBeUndefined();
    delete process.env.DATABASE_URL;
  });

  it("returns timedOut=true and exitCode=-1 on timeout", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const err = new Error("timed out") as NodeJS.ErrnoException;
      err.name = "AbortError";
      cb(err);
    });
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner(baseOpts);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it("captures stderr and non-zero exit code on failure", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const err = new Error("tsc failed") as NodeJS.ErrnoException & {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      err.exitCode = 2;
      err.stdout = "";
      err.stderr = "error TS2322: Type mismatch\n";
      cb(err);
    });
    const orc = ContainerOrchestrator.getInstance();
    const result = await orc.runRunner(baseOpts);
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("TS2322");
  });

  it("disables networking (--network none)", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner(baseOpts);
    const args: string[] = mockExecFile.mock.calls[0][1] as string[];
    const netIdx = args.indexOf("--network");
    expect(netIdx).toBeGreaterThan(-1);
    expect(args[netIdx + 1]).toBe("none");
  });

  it("applies CPU and memory limits", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      cb(null, "", "");
    });
    const orc = ContainerOrchestrator.getInstance();
    await orc.runRunner({ ...baseOpts, cpuLimit: "1", memoryLimit: "2g" });
    const args: string[] = mockExecFile.mock.calls[0][1] as string[];
    const cpuIdx = args.indexOf("--cpus");
    const memIdx = args.indexOf("--memory");
    expect(args[cpuIdx + 1]).toBe("1");
    expect(args[memIdx + 1]).toBe("2g");
  });
});
