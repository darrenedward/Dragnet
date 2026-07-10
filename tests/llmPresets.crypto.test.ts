import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptApiKey, decryptApiKey } from "../src/lib/llmPresets/crypto";

const mocks = vi.hoisted(() => ({
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
}));

vi.mock("../src/lib/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));

describe("encryptApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for empty key", () => {
    expect(encryptApiKey("")).toBeNull();
  });

  it("calls encryptSecret and returns result", () => {
    mocks.encryptSecret.mockReturnValue({
      cipher: "encrypted",
      iv: "iv123",
      tag: "tag456",
    });
    const result = encryptApiKey("sk-abc123");
    expect(result).toEqual({
      cipher: "encrypted",
      iv: "iv123",
      tag: "tag456",
    });
    expect(mocks.encryptSecret).toHaveBeenCalledWith("sk-abc123");
  });

  it("returns null when encryptSecret throws", () => {
    mocks.encryptSecret.mockImplementation(() => {
      throw new Error("no master key");
    });
    const result = encryptApiKey("sk-abc123");
    expect(result).toBeNull();
  });
});

describe("decryptApiKey", () => {
  it("calls decryptSecret and returns plaintext", () => {
    mocks.decryptSecret.mockReturnValue("sk-abc123");
    const result = decryptApiKey("cipher", "iv", "tag");
    expect(result).toBe("sk-abc123");
    expect(mocks.decryptSecret).toHaveBeenCalledWith("cipher", "iv", "tag");
  });
});
