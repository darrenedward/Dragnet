import { existsSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export async function register() {
  const g = globalThis as typeof globalThis & { __dragnetAuditDone?: boolean };
  if (g.__dragnetAuditDone) return;
  g.__dragnetAuditDone = true;

  let root: string;
  try {
    root = /* turbopackIgnore: true */ process.cwd();
  } catch {
    return;
  }

  const files: string[] = [];

  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = join(root, name);
    if (existsSync(p)) files.push(p);
  }

  const dragnetDir = join(root, ".dragnet");
  if (existsSync(dragnetDir)) {
    try {
      for (const entry of readdirSync(dragnetDir)) {
        files.push(join(dragnetDir, entry));
      }
    } catch {}
  }

  const fixed: string[] = [];
  for (const p of files) {
    try {
      const mode = statSync(p).mode;
      if (mode & 0o077) {
        chmodSync(p, 0o600);
        fixed.push(p);
      }
    } catch {}
  }
  if (fixed.length > 0) {
    console.warn(`[startup-audit] fixed mode to 0600: ${fixed.join(", ")}`);
  }
}
