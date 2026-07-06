import { describe, it, expect } from "vitest";
import { shellEscape } from "../src/lib/shellEscape";

describe("shellEscape", () => {
  it("passes through a normal string without single quotes", () => {
    expect(shellEscape("hello world")).toBe("hello world");
  });

  it("escapes a single quote", () => {
    expect(shellEscape("it's")).toBe("it'\\''s");
  });

  it("escapes multiple single quotes", () => {
    expect(shellEscape("'a' 'b'")).toBe("'\\''a'\\'' '\\''b'\\''");
  });

  it("escapes a string with only single quotes", () => {
    expect(shellEscape("'''")).toBe("'\\'''\\'''\\''");
  });

  it("produces a safe shell-quoted string when embedded in single quotes", () => {
    const url = "https://github.com/user/repo's-project.git";
    const escaped = shellEscape(url);
    const shellExpr = `'${escaped}'`;
    const expected =
      "'https://github.com/user/repo'\\''s-project.git'";
    expect(shellExpr).toBe(expected);
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("");
  });

  it("handles strings with no special characters", () => {
    expect(shellEscape("https://github.com/user/repo.git")).toBe(
      "https://github.com/user/repo.git",
    );
  });

  it("passes through a PAT-interpolated URL unchanged (no single quotes)", () => {
    const url = "https://x-access-token:ghp_abc123@github.com/user/repo.git";
    expect(shellEscape(url)).toBe(url);
  });
});
