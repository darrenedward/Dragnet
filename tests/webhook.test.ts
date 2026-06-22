import { describe, it, expect } from "vitest";
import { verifyGithubSignature } from "../src/lib/webhook";

describe("verifyGithubSignature", () => {
  it("returns true for valid signature", () => {
    const payload = '{"test": true}';
    const secret = "mysecret";
    const result = verifyGithubSignature(payload, "sha256=78b8272a3e6aa314459c5a44165071045b56ca759740e810642b85042752b073", secret);
    expect(result).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const result = verifyGithubSignature('{"test": true}', "sha256=invalid", "mysecret");
    expect(result).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const result = verifyGithubSignature('{"test": true}', "sha256=abc", "");
    expect(result).toBe(false);
  });

  it("returns false when signature is empty", () => {
    const result = verifyGithubSignature('{"test": true}', "", "mysecret");
    expect(result).toBe(false);
  });

  it("returns false for malformed signature", () => {
    const result = verifyGithubSignature('{"test": true}', "not-sha256-format", "mysecret");
    expect(result).toBe(false);
  });
});
