import { describe, it, expect } from "vitest";
import { buildFetchRefspec } from "../../src/lib/gitService";

describe("buildFetchRefspec", () => {
  it("builds a single-quote-wrapped refspec for one branch", () => {
    expect(buildFetchRefspec(["main"])).toBe(
      "'+refs/heads/main:refs/heads/main'",
    );
  });

  it("joins multiple single-quote-wrapped refspecs with spaces", () => {
    expect(buildFetchRefspec(["main", "feature/auth"])).toBe(
      "'+refs/heads/main:refs/heads/main' '+refs/heads/feature/auth:refs/heads/feature/auth'",
    );
  });

  it("passes branch names with hyphens, dots, and underscores through verbatim", () => {
    expect(buildFetchRefspec(["release/v1.2.3_rc"])).toBe(
      "'+refs/heads/release/v1.2.3_rc:refs/heads/release/v1.2.3_rc'",
    );
  });

  it("returns an empty string for an empty input", () => {
    expect(buildFetchRefspec([])).toBe("");
  });
});