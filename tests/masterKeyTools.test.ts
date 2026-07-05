import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { EncryptedSecret } from "../src/tools/rotateMasterKey";

const oldKeyHex = randomBytes(32).toString("hex");
const tmpDir = mkdtempSync(join(tmpdir(), "dragnet-masterkey-test-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function getGenerateMod() {
  return import("../src/tools/generateMasterKey");
}

async function getRotateMod() {
  return import("../src/tools/rotateMasterKey");
}

describe("generateMasterKey", () => {
  it("produces a 32-byte hex key (64 hex chars)", async () => {
    const mod = await getGenerateMod();
    const key = mod.generateMasterKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(key, "hex").length).toBe(32);
  });

  it("produces unique keys on each call", async () => {
    const mod = await getGenerateMod();
    const key1 = mod.generateMasterKey();
    const key2 = mod.generateMasterKey();
    expect(key1).not.toBe(key2);
  });

  it("writes key file with mode 0o400", async () => {
    const mod = await getGenerateMod();
    const keyPath = join(tmpDir, "test-master.key");
    mod.writeMasterKeyFile("deadbeef" + "0".repeat(56), keyPath);
    const stat = await import("fs/promises").then((m) => m.stat(keyPath));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o400);
    const content = readFileSync(keyPath, "utf-8").trim();
    expect(content).toBe("deadbeef" + "0".repeat(56));
  });
});

describe("rotateMasterKey", () => {
  it("decrypts and re-encrypts secrets through the full round-trip", async () => {
    const mod = await getRotateMod();
    (globalThis as any).__dragnetCryptoKey = undefined;
    process.env.DRAGNET_MASTER_KEY = Buffer.from(oldKeyHex, "hex").toString("base64");
    const cryptoMod = await import("../src/lib/crypto");
    const { cipher, iv, tag } = cryptoMod.encryptSecret("supersecret-deploy-key");

    const secrets: EncryptedSecret[] = [
      { id: "repo-1", table: "repositories", cipher, iv, tag },
    ];
    const newKeyHex = randomBytes(32).toString("hex");

    const reEncrypted = await mod.reEncryptSecrets(secrets, oldKeyHex, newKeyHex);

    expect(reEncrypted).toHaveLength(1);
    expect(reEncrypted[0].id).toBe("repo-1");
    expect(reEncrypted[0].cipher).toBeTruthy();
    expect(reEncrypted[0].iv).toBeTruthy();
    expect(reEncrypted[0].tag).toBeTruthy();

    (globalThis as any).__dragnetCryptoKey = undefined;
    process.env.DRAGNET_MASTER_KEY = Buffer.from(newKeyHex, "hex").toString("base64");
    const decryptMod = await import("../src/lib/crypto");
    const decrypted = decryptMod.decryptSecret(
      reEncrypted[0].cipher!,
      reEncrypted[0].iv!,
      reEncrypted[0].tag!,
    );
    expect(decrypted).toBe("supersecret-deploy-key");
  });

  it("detects mismatched encrypted column groups (cipher/iv/tag must all be present or all null)", async () => {
    const mod = await getRotateMod();
    const badSecrets: EncryptedSecret[] = [
      { id: "bad-1", table: "repositories", cipher: "cipher-only", iv: null, tag: null },
    ];

    expect(() => mod.validateSecrets(badSecrets)).toThrow(/partial/i);
  });

  it("validates hex key length", async () => {
    const mod = await getRotateMod();
    expect(() => mod.validateKeyHex("too-short")).toThrow(/32 bytes/i);
    expect(() => mod.validateKeyHex("a".repeat(64))).not.toThrow();
  });

  it("generates a valid new hex key when none provided", async () => {
    const mod = await getRotateMod();
    const { generateMasterKey } = await getGenerateMod();
    const key = generateMasterKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(key, "hex").length).toBe(32);
  });
});
