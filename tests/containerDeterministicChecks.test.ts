import { describe, it, expect, vi, beforeEach } from "vitest";
import { runContainerizedChecks } from "../src/services/deterministicChecks/containerRunner";
import type { ContainerizedCheckOptions } from "../src/services/deterministicChecks/containerRunner";

const mockSyncToCommit = vi.fn();
const mockRunRunner = vi.fn();

const mockReviewLogCreate = vi.fn().mockResolvedValue({});

vi.mock("../src/lib/gitService", () => ({
  gitService: {
    syncToCommit: (...args: unknown[]) => mockSyncToCommit(...args),
  },
  setGitService: vi.fn(),
}));

vi.mock("../src/lib/containerOrchestrator", () => ({
  ContainerOrchestrator: {
    getInstance: () => ({
      createVolume: vi.fn(),
      deleteVolume: vi.fn(),
      runRunner: (...args: unknown[]) => mockRunRunner(...args),
    }),
    setInstance: vi.fn(),
  },
  detectContainerEngine: () => "docker",
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    reviewLog: {
      create: (...args: unknown[]) => mockReviewLogCreate(...args),
    },
  },
}));

const baseOpts: ContainerizedCheckOptions = {
  repoId: "test-repo-1",
  cloneUrl: "https://github.com/test/repo.git",
  commitHash: "abc123def456",
  runnerImage: "node:22-alpine",
  installCommand: "npm install",
  testCommand: "npm test && npm run lint",
  prId: "pr-test-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSyncToCommit.mockResolvedValue("/workspace");
});

describe("runContainerizedChecks", () => {
  it("returns empty findings when install and test succeed", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "Tests passed!", stderr: "", timedOut: false });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(0);
    expect(mockSyncToCommit).toHaveBeenCalledTimes(1);
    expect(mockRunRunner).toHaveBeenCalledTimes(2);
  });

  it("syncs the repo to a Docker volume before running checks", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await runContainerizedChecks(baseOpts);
    expect(mockSyncToCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: "test-repo-1",
        cloneUrl: "https://github.com/test/repo.git",
        commitHash: "abc123def456",
      }),
    );
  });

  it("passes deployKey and pat to git sync when provided", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await runContainerizedChecks({
      ...baseOpts,
      deployKey: "ssh-ed25519 AAAA...",
      pat: "ghp_test123",
    });

    expect(mockSyncToCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        deployKey: "ssh-ed25519 AAAA...",
        pat: "ghp_test123",
      }),
    );
  });

  it("runs install then test commands in separate containers", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await runContainerizedChecks(baseOpts);
    expect(mockRunRunner).toHaveBeenCalledTimes(2);

    const firstCall = mockRunRunner.mock.calls[0][0];
    expect(firstCall.commands).toContain(baseOpts.installCommand);

    const secondCall = mockRunRunner.mock.calls[1][0];
    expect(secondCall.commands).toContain(baseOpts.testCommand);
  });

  it("mounts the correct volume name", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await runContainerizedChecks(baseOpts);
    expect(mockRunRunner).toHaveBeenCalledWith(
      expect.objectContaining({ volumeName: "dragnet-repo-test-repo-1" }),
    );
  });

  it("uses default runnerImage and commands when repo ones are empty", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    await runContainerizedChecks(baseOpts);
    expect(mockRunRunner).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ image: "node:22-alpine" }),
    );
  });

  it("returns skippedFinding when git sync fails", async () => {
    mockSyncToCommit.mockRejectedValue(new Error("Failed to fetch origin"));

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].category).toBe("Skipped");
    expect(findings[0].explanation).toContain("Git sync failed");
    expect(mockRunRunner).not.toHaveBeenCalled();
  });

  it("returns no findings and continues when install fails but is not fatal", async () => {
    mockRunRunner.mockResolvedValueOnce({
      exitCode: 1, stdout: "npm ERR!", stderr: "install failed", timedOut: false,
    });

    const findings = await runContainerizedChecks(baseOpts);
    expect(mockRunRunner).toHaveBeenCalledTimes(1);
    expect(mockRunRunner).not.toHaveBeenCalledTimes(2);
  });

  it("skips test execution when install times out", async () => {
    mockRunRunner.mockResolvedValueOnce({
      exitCode: -1, stdout: "", stderr: "", timedOut: true,
    });

    const findings = await runContainerizedChecks(baseOpts);
    expect(mockRunRunner).toHaveBeenCalledTimes(1);
    expect(findings).toHaveLength(0);
  });

  it("parses tsc diagnostics from test stdout", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "/workspace/src/index.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.\n/workspace/src/utils.ts(10,3): warning TS6133: 'x' is declared but never used.",
        stderr: "",
        timedOut: false,
      });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe("tsc");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].filename).toBe("/workspace/src/index.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].explanation).toContain("TS2322");

    expect(findings[1].severity).toBe("warning");
    expect(findings[1].explanation).toContain("TS6133");
  });

  it("parses eslint JSON output from test stdout", async () => {
    const eslintOutput = JSON.stringify([
      {
        filePath: "/workspace/src/app.ts",
        messages: [
          { line: 15, severity: 2, ruleId: "no-unused-vars", message: "'x' is defined but never used" },
          { line: 22, severity: 1, ruleId: "semi", message: "Missing semicolon" },
        ],
      },
    ]);

    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: eslintOutput,
        stderr: "",
        timedOut: false,
      });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe("eslint");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].explanation).toContain("no-unused-vars");
    expect(findings[1].severity).toBe("warning");
    expect(findings[1].explanation).toContain("semi");
  });

  it("returns timedOut finding when test times out", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({
        exitCode: -1, stdout: "", stderr: "", timedOut: true,
      });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].explanation).toContain("timed out");
  });

  it("returns info finding when test exits non-zero but output is unparseable", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "some random error output",
        stderr: "not a standard format",
        timedOut: false,
      });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].category).toBe("Skipped");
    expect(findings[0].explanation).toContain("exited with code 1");
  });

  it("logs container output with 'info' level, not 'tool_call'", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "tests passed", stderr: "", timedOut: false });

    await runContainerizedChecks(baseOpts);

    const containerLogCalls = mockReviewLogCreate.mock.calls.filter(
      (c: any) => {
        const msg = c[0]?.data?.message ?? "";
        return msg.startsWith("[install]") || msg.startsWith("[test]");
      },
    );

    expect(containerLogCalls.length).toBeGreaterThan(0);
    for (const call of containerLogCalls) {
      expect(call[0].data.level).toBe("info");
    }

    const toolCallLogs = mockReviewLogCreate.mock.calls.filter(
      (c: any) => c[0]?.data?.level === "tool_call",
    );
    expect(toolCallLogs).toHaveLength(0);
  });

  it("runs with custom runnerImage and commands", async () => {
    const customOpts: ContainerizedCheckOptions = {
      ...baseOpts,
      runnerImage: "python:3.12-slim",
      installCommand: "pip install -r requirements.txt",
      testCommand: "pytest",
    };

    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "All tests passed!", stderr: "", timedOut: false });

    const findings = await runContainerizedChecks(customOpts);
    expect(findings).toHaveLength(0);

    expect(mockRunRunner).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ image: "python:3.12-slim", commands: ["pip install -r requirements.txt"] }),
    );
    expect(mockRunRunner).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ image: "python:3.12-slim", commands: ["pytest"] }),
    );
  });

  it("parseGenericErrors uses source 'runner' not 'tsc' for non-tsc/eslint output", async () => {
    mockRunRunner
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "Error: npm ERR! command failed\nError: Cannot find module 'foo'\n  at require (internal/modules/cjs/helpers.js)",
        timedOut: false,
      });

    const findings = await runContainerizedChecks(baseOpts);
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.source).toBe("runner");
    }
    expect(findings[0].explanation).toContain("npm ERR!");
    expect(findings[1].explanation).toContain("Cannot find module");
  });
});
