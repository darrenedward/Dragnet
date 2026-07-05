import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

export interface EncryptedSecret {
  id: string;
  table: string;
  cipher: string | null;
  iv: string | null;
  tag: string | null;
}

export function validateKeyHex(key: string): void {
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(`Master key must be 32 bytes (64 hex chars), got ${key.length} chars`);
  }
}

export function validateSecrets(secrets: EncryptedSecret[]): void {
  for (const s of secrets) {
    const cols = [s.cipher, s.iv, s.tag];
    const nonNull = cols.filter((c) => c !== null);
    if (nonNull.length > 0 && nonNull.length < 3) {
      throw new Error(
        `Partial encrypted columns for ${s.table}.${s.id}: cipher/iv/tag must all be set or all null`,
      );
    }
  }
}

export async function reEncryptSecrets(
  secrets: EncryptedSecret[],
  oldKeyHex: string,
  newKeyHex: string,
): Promise<EncryptedSecret[]> {
  validateSecrets(secrets);
  validateKeyHex(oldKeyHex);
  validateKeyHex(newKeyHex);

  (globalThis as any).__dragnetCryptoKey = undefined;
  process.env.DRAGNET_MASTER_KEY = Buffer.from(oldKeyHex, "hex").toString("base64");
  const { decryptSecret } = await import("../lib/crypto");

  const decrypted: { id: string; table: string; plaintext: string }[] = [];
  for (const s of secrets) {
    if (s.cipher && s.iv && s.tag) {
      const plaintext = decryptSecret(s.cipher, s.iv, s.tag);
      decrypted.push({ id: s.id, table: s.table, plaintext });
    }
  }

  (globalThis as any).__dragnetCryptoKey = undefined;
  process.env.DRAGNET_MASTER_KEY = Buffer.from(newKeyHex, "hex").toString("base64");
  const { encryptSecret } = await import("../lib/crypto");

  return secrets.map((s) => {
    const entry = decrypted.find((d) => d.id === s.id && d.table === s.table);
    if (entry) {
      const { cipher, iv, tag } = encryptSecret(entry.plaintext);
      return { ...s, cipher, iv, tag };
    }
    return { ...s };
  });
}

export function atomicWriteKeyFile(key: string, filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + ".tmp." + randomBytes(4).toString("hex");
  writeFileSync(tmpPath, key + "\n", { mode: 0o400 });
  renameSync(tmpPath, filePath);
}

export function readKeyFile(filePath: string): string {
  return readFileSync(filePath, "utf-8").trim();
}

export function generateNewKey(): string {
  return randomBytes(32).toString("hex");
}
