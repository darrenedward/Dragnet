import { describe, it, expect } from "vitest";
import {
  generateScanTokenRaw,
  hashScanToken,
} from "../../src/services/hostedScan/scanToken";

describe("ScanToken generation", () => {
  it("produces a token with the hs_ prefix", () => {
    const token = generateScanTokenRaw();
    expect(token.raw).toMatch(/^hs_[a-f0-9]{64}$/);
    expect(token.prefix).toMatch(/^hs_[a-f0-9]{5}\.\.\.$/);
    expect(token.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces a deterministic hash for the same raw token", () => {
    const raw = "hs_" + "a".repeat(64);
    const hash1 = hashScanToken(raw);
    const hash2 = hashScanToken(raw);
    expect(hash1).toBe(hash2);
  });

  it("returns null for tokens without the hs_ prefix", () => {
    expect(hashScanToken("dr_abc123")).toBeNull();
    expect(hashScanToken("")).toBeNull();
    expect(hashScanToken("hs")).toBeNull();
  });

  it("generates unique raw tokens on successive calls", () => {
    const t1 = generateScanTokenRaw();
    const t2 = generateScanTokenRaw();
    expect(t1.raw).not.toBe(t2.raw);
    expect(t1.hash).not.toBe(t2.hash);
  });
});

describe("ScanToken validation", () => {
  it("validates a token against its stored hash", () => {
    const token = generateScanTokenRaw();
    const computed = hashScanToken(token.raw);
    expect(computed).toBe(token.hash);
  });

  it("rejects a tampered token", () => {
    const token = generateScanTokenRaw();
    const tampered = token.raw.slice(0, -1) + "0";
    const computed = hashScanToken(tampered);
    expect(computed).not.toBe(token.hash);
  });

  it("rejects wrong-prefix tokens", () => {
    expect(hashScanToken("dr_abc123")).toBeNull();
    expect(hashScanToken("invalid")).toBeNull();
  });
});
