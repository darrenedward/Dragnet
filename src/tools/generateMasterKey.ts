import { randomBytes } from "crypto";
import { writeFileSync, chmodSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const KEY_BYTES = 32;

export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("hex");
}

export function writeMasterKeyFile(key: string, filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, key + "\n", { mode: 0o400 });
  chmodSync(filePath, 0o400);
}

export function cli(args: string[] = process.argv): void {
  const filePath = args[2] || "/var/lib/dragnet/master.key";
  const key = generateMasterKey();
  writeMasterKeyFile(key, filePath);
  console.log("Master key written to", filePath);
}
