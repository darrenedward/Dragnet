import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectionResult } from "@/src/services/deterministicChecks/types";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockParseEslintJson = vi.fn();
vi.mock("@/src/services/deterministicChecks/parsers", () => ({
  parseEslintJson: (...args: unknown[]) => mockParseEslintJson(...args),
}));

const { eslintRunner } = await import("@/src/services/deterministicChecks/eslintRunner");

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

describe("eslintRunner", () => {
  it("returns skipped finding when node_modules is missing", async () => {
    const detection = makeDetection({ hasNodeModules: false });
    const findings = await eslintRunner.run(detection);
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toContain("node_modules/ missing");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("runs eslint --format json by default and returns parsed findings", async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ filePath: "test.ts", messages: [{ line: 1, severity: 2, ruleId: "no-console", message: "Unexpected console" }] }]));
    mockParseEslintJson.mockReturnValue([{ filename: "test.ts", line: 1, severity: "error", category: "Lint", explanation: "no-console: Unexpected console", source: "eslint" }]);

    const findings = await eslintRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("eslint");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["exec", "eslint", ".", "--format", "json"],
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("uses npm run lint when scripts.lint is defined", async () => {
    mockExecFileSync.mockReturnValue("[]");
    mockParseEslintJson.mockReturnValue([]);

    await eslintRunner.run(makeDetection({ scripts: { lint: "eslint ." } }));
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npm",
      ["run", "lint"],
      expect.any(Object),
    );
  });

  it("parses eslint JSON when lint script produces parseable output", async () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([{ filePath: "test.ts", messages: [{ line: 1, severity: 2, ruleId: "no-console", message: "Unexpected console" }] }]));
    mockParseEslintJson.mockReturnValue([{ filename: "test.ts", line: 1, severity: "error", category: "Lint", explanation: "no-console: Unexpected console", source: "eslint" }]);

    const findings = await eslintRunner.run(makeDetection({ scripts: { lint: "eslint ." } }));
    expect(findings).toHaveLength(1);
    expect(mockParseEslintJson).toHaveBeenCalled();
  });

  it("returns skipped finding when lint script produces unparseable output", async () => {
    mockExecFileSync.mockReturnValue("> test@1.0.0 lint\n> eslint .\nsome random text");
    mockParseEslintJson.mockReturnValue([]);

    const findings = await eslintRunner.run(makeDetection({ scripts: { lint: "eslint ." } }));
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("Skipped");
    expect(findings[0].explanation).toContain("unparseable");
  });

  it("returns empty when lint script produces only npm echo lines", async () => {
    mockExecFileSync.mockReturnValue("> test@1.0.0 lint\n> eslint .\n");
    mockParseEslintJson.mockReturnValue([]);

    const findings = await eslintRunner.run(makeDetection({ scripts: { lint: "eslint ." } }));
    expect(findings).toHaveLength(0);
  });

  it("returns stdout on exit code 1", async () => {
    const eslintJson = JSON.stringify([{ filePath: "test.ts", messages: [{ line: 1, severity: 2, ruleId: "no-debugger", message: "Unexpected debugger" }] }]);
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("eslint found issues"), {
        status: 1,
        stdout: eslintJson,
      });
    });
    mockParseEslintJson.mockReturnValue([{ filename: "test.ts", line: 1, severity: "error", category: "Lint", explanation: "no-debugger: Unexpected debugger", source: "eslint" }]);

    const findings = await eslintRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("eslint");
  });

  it("returns skipped finding on exit code 2 (config error)", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("eslint config error"), {
        status: 2,
        stdout: "",
      });
    });

    const findings = await eslintRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toContain("config error");
  });

  it("returns skipped finding on unexpected error", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("Command not found");
    });

    const findings = await eslintRunner.run(makeDetection());
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toContain("Command not found");
  });
});
