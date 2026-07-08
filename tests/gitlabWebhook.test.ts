import { describe, it, expect } from "vitest";
import { verifyGitlabToken } from "../src/lib/webhook";

describe("verifyGitlabToken", () => {
  it("returns true for exact matching token", () => {
    const secret = "super-secret-token";
    const result = verifyGitlabToken(secret, secret);
    expect(result).toBe(true);
  });

  it("returns false for non-matching token", () => {
    const result = verifyGitlabToken("wrong-token", "super-secret-token");
    expect(result).toBe(false);
  });

  it("returns false for partial matching token (prefix)", () => {
    const result = verifyGitlabToken("super-secret", "super-secret-token");
    expect(result).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const result = verifyGitlabToken("token", "");
    expect(result).toBe(false);
  });

  it("returns false when token is empty", () => {
    const result = verifyGitlabToken("", "secret");
    expect(result).toBe(false);
  });

  it("handles different lengths safely (timingSafeEqual test)", () => {
    // Before hashing, different lengths would throw in timingSafeEqual.
    // Our fix hashes both to 32 bytes first.
    const result = verifyGitlabToken("a".repeat(10), "a".repeat(20));
    expect(result).toBe(false);
  });
});
