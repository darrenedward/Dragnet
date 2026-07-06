import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

const SCAN_TOKEN_PREFIX = "hs_";

function generateScanTokenRaw(): { raw: string; prefix: string; hash: string } {
  const raw = SCAN_TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
  const prefix = raw.slice(0, 8) + "...";
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, prefix, hash };
}

function hashToken(raw: string): string | null {
  if (!raw.startsWith(SCAN_TOKEN_PREFIX)) return null;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

describe("ScanToken generation", () => {
  it("produces a token with the hs_ prefix", () => {
    const token = generateScanTokenRaw();
    expect(token.raw).toMatch(/^hs_[a-f0-9]{64}$/);
    expect(token.prefix).toMatch(/^hs_[a-f0-9]{5}\.\.\.$/);
    expect(token.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces a deterministic hash for the same raw token", () => {
    const raw = "hs_" + "a".repeat(64);
    const hash1 = hashToken(raw);
    const hash2 = hashToken(raw);
    expect(hash1).toBe(hash2);
  });

  it("returns null for tokens without the hs_ prefix", () => {
    expect(hashToken("dr_abc123")).toBeNull();
    expect(hashToken("")).toBeNull();
    expect(hashToken("hs")).toBeNull();
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
    const computed = hashToken(token.raw);
    expect(computed).toBe(token.hash);
  });

  it("rejects a tampered token", () => {
    const token = generateScanTokenRaw();
    const tampered = token.raw.slice(0, -1) + "0";
    const computed = hashToken(tampered);
    expect(computed).not.toBe(token.hash);
  });

  it("rejects wrong-prefix tokens", () => {
    expect(hashToken("dr_abc123")).toBeNull();
    expect(hashToken("invalid")).toBeNull();
  });
});
