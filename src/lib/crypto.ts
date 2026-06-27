import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;

interface KeyStore {
  masterKey: Buffer;
}

function getKeyStore(): KeyStore {
  const g = globalThis as typeof globalThis & { __dragnetCryptoKey?: KeyStore };
  if (!g.__dragnetCryptoKey) {
    const raw = process.env.DRAGNET_MASTER_KEY;
    if (!raw) throw new Error("DRAGNET_MASTER_KEY is not set (32-byte, base64)");
    const masterKey = Buffer.from(raw, "base64");
    if (masterKey.length !== KEY_LEN) {
      throw new Error(
        `DRAGNET_MASTER_KEY must be ${KEY_LEN} bytes encoded as base64 (got ${masterKey.length} bytes)`,
      );
    }
    g.__dragnetCryptoKey = { masterKey };
  }
  return g.__dragnetCryptoKey;
}

export function hasMasterKey(): boolean {
  try {
    getKeyStore();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext: string): { cipher: string; iv: string; tag: string } {
  const { masterKey } = getKeyStore();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(cipher: string, iv: string, tag: string): string {
  const { masterKey } = getKeyStore();
  const decipher = createDecipheriv(ALGO, masterKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipher, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
