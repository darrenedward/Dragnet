import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import crypto from "crypto";

const masterKey = crypto.randomBytes(32).toString("base64");

beforeAll(() => {
  process.env.DRAGNET_MASTER_KEY = masterKey;
});

beforeEach(() => {
  delete (globalThis as any).__dragnetCryptoKey;
  process.env.DRAGNET_MASTER_KEY = masterKey;
});

async function getMod() {
  return import("../src/lib/crypto");
}

describe("crypto", () => {
  it("encrypt/decrypt round-trip", async () => {
    const mod = await getMod();
    const result = mod.encryptSecret("hello world");
    expect(result.cipher).toBeTruthy();
    expect(result.iv).toBeTruthy();
    expect(result.tag).toBeTruthy();
    const decrypted = mod.decryptSecret(result.cipher, result.iv, result.tag);
    expect(decrypted).toBe("hello world");
  });

  it("hasMasterKey returns true when key is set", async () => {
    const mod = await getMod();
    expect(mod.hasMasterKey()).toBe(true);
  });

  it("hasMasterKey returns false when key is missing", async () => {
    delete process.env.DRAGNET_MASTER_KEY;
    const mod = await getMod();
    expect(mod.hasMasterKey()).toBe(false);
  });

  it("wrong tag fails decryption", async () => {
    const mod = await getMod();
    const result = mod.encryptSecret("test");
    expect(() => mod.decryptSecret(result.cipher, result.iv, "AAAAAAAAAAAAAAAAAAAAAA==")).toThrow();
  });
});
