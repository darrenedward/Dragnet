import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseGenericErrors } from "@/src/services/deterministicChecks/containerRunner";

describe("parseGenericErrors", () => {
  it("returns findings with source 'runner' (not 'tsc')", () => {
    const stderr = "Error: something broke\nERROR: critical failure";
    const findings = parseGenericErrors(stderr);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.source).toBe("runner");
    }
  });

  it("matches error lines and extracts filename and explanation", () => {
    const stderr = "error src/app.ts: cannot find module 'foo'";
    const findings = parseGenericErrors(stderr);
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("src/app.ts");
    expect(findings[0].line).toBe(0);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].category).toBe("Build Error");
    expect(findings[0].explanation).toBe("cannot find module 'foo'");
    expect(findings[0].source).toBe("runner");
  });

  it("uses '<output>' as filename when no file is matched", () => {
    const stderr = "Error: npm ERR! Missing script: build";
    const findings = parseGenericErrors(stderr);
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("<output>");
  });

  it("returns empty array for empty stderr", () => {
    expect(parseGenericErrors("")).toEqual([]);
  });

  it("returns empty array for non-error stderr", () => {
    expect(parseGenericErrors("warning: this is fine")).toEqual([]);
  });
});
