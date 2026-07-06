import { describe, it, expect } from "vitest";
import { parseTscOutput, parseEslintJson } from "@/src/services/deterministicChecks/parsers";

describe("parseTscOutput", () => {
  it("parses a single TS error with file, line, column, code, and message", () => {
    const input = "/workspace/src/index.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const findings = parseTscOutput(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("/workspace/src/index.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].category).toBe("Type Error");
    expect(findings[0].explanation).toBe("TS2322: Type 'string' is not assignable to type 'number'.");
    expect(findings[0].source).toBe("tsc");
  });

  it("parses multiple TS diagnostics", () => {
    const input = [
      "/workspace/src/a.ts(1,1): error TS1000: first error.",
      "/workspace/src/b.ts(5,3): warning TS6133: 'x' is declared but never used.",
    ].join("\n");
    const findings = parseTscOutput(input);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("error");
    expect(findings[1].severity).toBe("warning");
  });

  it("returns empty array for clean output", () => {
    expect(parseTscOutput("")).toEqual([]);
  });

  it("returns empty array for non-matching output", () => {
    const input = "npm ERR! missing script: typecheck";
    expect(parseTscOutput(input)).toEqual([]);
  });

});

describe("parseEslintJson", () => {
  const sampleJson = JSON.stringify([
    {
      filePath: "/workspace/src/app.ts",
      messages: [
        { line: 15, severity: 2, ruleId: "no-unused-vars", message: "'x' is defined but never used" },
        { line: 22, severity: 1, ruleId: "semi", message: "Missing semicolon" },
      ],
    },
  ]);

  it("parses eslint JSON output into findings", () => {
    const findings = parseEslintJson(sampleJson);
    expect(findings).toHaveLength(2);
    expect(findings[0].filename).toBe("/workspace/src/app.ts");
    expect(findings[0].line).toBe(15);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].category).toBe("Lint");
    expect(findings[0].explanation).toBe("no-unused-vars: 'x' is defined but never used");
    expect(findings[0].source).toBe("eslint");
    expect(findings[1].severity).toBe("warning");
    expect(findings[1].explanation).toBe("semi: Missing semicolon");
  });

  it("makes paths relative to rootDir when rootDir provided", () => {
    const findings = parseEslintJson(sampleJson, "/workspace");
    expect(findings[0].filename).toBe("src/app.ts");
  });

  it("returns empty array for unparseable output", () => {
    expect(parseEslintJson("not json")).toEqual([]);
  });

  it("returns empty array for empty JSON array", () => {
    expect(parseEslintJson("[]")).toEqual([]);
  });

  it("skips messages without a line number", () => {
    const json = JSON.stringify([
      {
        filePath: "/workspace/src/app.ts",
        messages: [{ line: 0, severity: 2, ruleId: "no-console", message: "Unexpected console" }],
      },
    ]);
    const findings = parseEslintJson(json);
    // line 0 is falsy — should be skipped
    expect(findings).toHaveLength(0);
  });

  it("handles null ruleId gracefully", () => {
    const json = JSON.stringify([
      {
        filePath: "test.ts",
        messages: [{ line: 1, severity: 2, ruleId: null, message: "Fatal error" }],
      },
    ]);
    const findings = parseEslintJson(json);
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toBe("Fatal error");
  });
});
