import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectionResult } from "@/src/services/deterministicChecks/types";

const mockDetectJs = vi.fn();
const mockDetectTs = vi.fn();
const mockTscRun = vi.fn();
const mockEslintRun = vi.fn();

vi.mock("@/src/services/deterministicChecks/typescriptDetector", () => ({
  typescriptDetector: { detect: (...args: unknown[]) => mockDetectTs(...args) },
}));

vi.mock("@/src/services/deterministicChecks/javascriptDetector", () => ({
  javascriptDetector: { detect: (...args: unknown[]) => mockDetectJs(...args) },
}));

vi.mock("@/src/services/deterministicChecks/tscRunner", () => ({
  tscRunner: { name: "tsc", run: (...args: unknown[]) => mockTscRun(...args) },
}));

vi.mock("@/src/services/deterministicChecks/eslintRunner", () => ({
  eslintRunner: { name: "eslint", run: (...args: unknown[]) => mockEslintRun(...args) },
}));

const { runDeterministicChecks } = await import("@/src/services/deterministicChecks/orchestrator");

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

describe("runDeterministicChecks", () => {
  it("runs TS detectors first and runs tsc + eslint when TypeScript detected", async () => {
    const detection = makeDetection();
    mockDetectTs.mockResolvedValue(detection);
    mockTscRun.mockResolvedValue([]);
    mockEslintRun.mockResolvedValue([]);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(0);
    expect(mockDetectTs).toHaveBeenCalledWith("/workspace");
    expect(mockDetectJs).not.toHaveBeenCalled();
    expect(mockTscRun).toHaveBeenCalledWith(detection);
    expect(mockEslintRun).toHaveBeenCalledWith(detection);
  });

  it("falls through to JS detector when TS does not match", async () => {
    const detection = makeDetection({ type: "javascript", tsconfigPath: undefined });
    mockDetectTs.mockResolvedValue(null);
    mockDetectJs.mockResolvedValue(detection);
    mockEslintRun.mockResolvedValue([]);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(0);
    expect(mockDetectTs).toHaveBeenCalled();
    expect(mockDetectJs).toHaveBeenCalled();
    expect(mockTscRun).not.toHaveBeenCalled();
    expect(mockEslintRun).toHaveBeenCalledWith(detection);
  });

  it("returns empty array when no detector matches", async () => {
    mockDetectTs.mockResolvedValue(null);
    mockDetectJs.mockResolvedValue(null);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(0);
  });

  it("aggregates findings from all runners", async () => {
    mockDetectTs.mockResolvedValue(makeDetection());
    mockTscRun.mockResolvedValue([
      { filename: "a.ts", line: 1, severity: "error", category: "Type Error", explanation: "TS2322: bad", source: "tsc" },
    ]);
    mockEslintRun.mockResolvedValue([
      { filename: "b.ts", line: 5, severity: "warning", category: "Lint", explanation: "semi: missing", source: "eslint" },
    ]);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe("tsc");
    expect(findings[1].source).toBe("eslint");
  });

  it("catches runner crashes and returns info finding", async () => {
    mockDetectTs.mockResolvedValue(makeDetection());
    mockTscRun.mockRejectedValue(new Error("tsc binary not found"));
    mockEslintRun.mockResolvedValue([]);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].category).toBe("Skipped");
    expect(findings[0].explanation).toContain("tsc runner crashed");
    expect(findings[0].source).toBe("tsc");
  });

  it("other runners still produce findings when one runner crashes", async () => {
    mockDetectTs.mockResolvedValue(makeDetection());
    mockTscRun.mockRejectedValue(new Error("crash"));
    mockEslintRun.mockResolvedValue([
      { filename: "a.ts", line: 1, severity: "warning", category: "Lint", explanation: "no-unused-vars", source: "eslint" },
    ]);

    const findings = await runDeterministicChecks("/workspace");
    expect(findings).toHaveLength(2);
    const sources = findings.map(f => f.source);
    expect(sources).toContain("tsc");
    expect(sources).toContain("eslint");
  });
});
