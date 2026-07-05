import { describe, it, expect, beforeEach } from "vitest";
import { verifyGithubSignature, verifyReplayAttack, resetRecentDeliveries } from "../src/lib/webhook";

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

describe("verifyReplayAttack", () => {
  beforeEach(() => {
    resetRecentDeliveries();
  });

  it("accepts a new delivery GUID", () => {
    expect(verifyReplayAttack("abc-123")).toBe(true);
  });

  it("rejects a duplicate delivery GUID", () => {
    verifyReplayAttack("dup-uuid");
    expect(verifyReplayAttack("dup-uuid")).toBe(false);
  });

  it("rejects a delivery GUID seen again multiple times", () => {
    verifyReplayAttack("dup-uuid");
    verifyReplayAttack("dup-uuid");
    expect(verifyReplayAttack("dup-uuid")).toBe(false);
  });

  it("accepts multiple unique delivery GUIDs", () => {
    expect(verifyReplayAttack("uuid-1")).toBe(true);
    expect(verifyReplayAttack("uuid-2")).toBe(true);
    expect(verifyReplayAttack("uuid-3")).toBe(true);
  });

  it("rejects empty delivery GUID", () => {
    expect(verifyReplayAttack("")).toBe(false);
  });

  it("rejects null delivery GUID", () => {
    expect(verifyReplayAttack(null as unknown as string)).toBe(false);
  });

  it("rejects undefined delivery GUID", () => {
    expect(verifyReplayAttack(undefined as unknown as string)).toBe(false);
  });
});
