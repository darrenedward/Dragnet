import { encryptSecret, decryptSecret } from "@/src/lib/crypto";

export interface EncryptedApiKey {
  cipher: string;
  iv: string;
  tag: string;
}

export function encryptApiKey(plaintext: string): EncryptedApiKey | null {
  if (!plaintext) return null;
  try {
    return encryptSecret(plaintext);
  } catch {
    return null;
  }
}

export function decryptApiKey(cipher: string, iv: string, tag: string): string {
  return decryptSecret(cipher, iv, tag);
}
