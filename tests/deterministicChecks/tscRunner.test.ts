import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectionResult } from "@/src/services/deterministicChecks/types";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("@/src/services/deterministicChecks/parsers", () => ({
  parseTscOutput: vi.fn((stdout) => {
    if (stdout.includes("TS2322")) {
      return [{ filename: "src/index.ts", line: 42, severity: "error", category: "Type Error", explanation: "TS2322: bad type", source: "tsc" }];
    }
    return [];
  }),
}));

const { tscRunner } = await import("@/src/services/deterministicChecks/tscRunner");

function makeDetection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    type: "typescript",
    rootDir: "/workspace",
    packageJsonPath: "/workspace/package.json",
    tsconfigPath: "/workspace/tsconfig.json",
    hasNodeModules: true,
    scripts: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tscRunner", () => {
  it("runs tsc --noEmit by default and returns empty findings on success", async () => {
    mockExecFileSync.mockReturnValue("");

    const findings = await tscRunner.run(makeDetection());
    expect(findings).toHaveLength(0);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["exec", "tsc", "--noEmit"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("uses npm run typecheck when scripts.typecheck is defined", async () => {
    mockExecFileSync.mockReturnValue("");

    const detection = makeDetection({ scripts: { typecheck: "tsc --noEmit --strict" } });
    await tscRunner.run(detection);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["run", "typecheck"],
      expect.any(Object),
    );
  });

  it("returns parsed findings when tsc finds errors (exit code 1)", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("tsc error"), {
        status: 1,
        stdout: "/workspace/src/index.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        stderr: "",
      });
    });

    const findings = await tscRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("tsc");
    expect(findings[0].severity).toBe("error");
  });

  it("returns skipped finding when tsc exits with code 2 (config error)", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("tsc config error"), {
        status: 2,
        stdout: "",
        stderr: "Cannot find tsconfig.json",
      });
    });

    const findings = await tscRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].category).toBe("Skipped");
    expect(findings[0].explanation).toContain("config error");
  });

  it("returns skipped finding when execFileSync throws unknown error", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("tsc not found");
    });

    const findings = await tscRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].explanation).toContain("tsc not found");
  });

  it("returns skipped finding when node_modules is missing", async () => {
    const detection = makeDetection({ hasNodeModules: false });
    const findings = await tscRunner.run(detection);
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toContain("node_modules/ missing");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
