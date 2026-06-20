import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

export interface DbConfigForm {
  dialect: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  sqliteFile?: string;
}

export interface DbConfigView {
  dialect: string;
  host: string;
  port: string;
  username: string;
  database: string;
  hasPassword: boolean;
  sqliteFile: string;
  isSupabase: boolean;
  configured: boolean;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

const ENV_LOCAL_PATH = join(process.cwd(), ".env.local");

export function isSupabaseHost(host: string): boolean {
  return host.toLowerCase().includes("supabase.com");
}

export function parseConnectionString(cs: string): {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  isSupabase: boolean;
} {
  if (!cs) {
    return { host: "", port: "", username: "", password: "", database: "", isSupabase: false };
  }
  try {
    const u = new URL(cs);
    const database = u.pathname.replace(/^\//, "") || "";
    const supabase = isSupabaseHost(u.hostname);
    return {
      host: u.hostname,
      port: u.port || (supabase ? "6543" : "5432"),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
      isSupabase: supabase,
    };
  } catch {
    return { host: "", port: "", username: "", password: "", database: "", isSupabase: false };
  }
}

export function buildConnectionString(form: DbConfigForm): string {
  if (form.dialect === "supabase") {
    return form.host.trim();
  }
  const user = form.username ? encodeURIComponent(form.username) : "";
  const pwd = form.password ? `:${encodeURIComponent(form.password)}` : "";
  const auth = user ? `${user}${pwd}@` : "";
  const port = form.port ? `:${form.port}` : "";
  const db = form.database ? `/${encodeURIComponent(form.database)}` : "";
  return `postgresql://${auth}${form.host}${port}${db}`;
}

export function viewFromEnv(): DbConfigView {
  const cs = process.env.DATABASE_URL || "";
  const parsed = parseConnectionString(cs);
  const isSupa = parsed.isSupabase;
  if (isSupa) {
    return {
      dialect: "supabase",
      host: cs,
      port: parsed.port,
      username: parsed.username,
      database: parsed.database,
      hasPassword: Boolean(parsed.password),
      sqliteFile: "data.db",
      isSupabase: true,
      configured: Boolean(cs),
    };
  }
  return {
    dialect: cs ? "postgresql" : "postgresql",
    host: parsed.host || "localhost",
    port: parsed.port || "5432",
    username: parsed.username,
    database: parsed.database,
    hasPassword: Boolean(parsed.password),
    sqliteFile: "data.db",
    isSupabase: false,
    configured: Boolean(cs),
  };
}

function stripSslMode(cs: string): string {
  return cs
    .replace(/&?sslmode=[^&]*/gi, "")
    .replace(/\?&/, "?")
    .replace(/\?$/, "")
    .replace(/&&/g, "&");
}

export async function testConnectionString(cs: string): Promise<TestResult> {
  if (!cs) return { ok: false, error: "Connection string is empty." };
  let pool: Pool | null = null;
  try {
    pool = new Pool({
      connectionString: stripSslMode(cs),
      connectionTimeoutMillis: 5000,
      max: 1,
      ssl: cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i)
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
    });
    const res = await pool.query("SELECT 1 AS ok");
    if (res.rows.length === 1 && res.rows[0].ok === 1) {
      return { ok: true };
    }
    return { ok: false, error: "Unexpected response from database." };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

export async function saveConnectionStringToEnvLocal(cs: string): Promise<void> {
  let contents = "";
  if (existsSync(ENV_LOCAL_PATH)) {
    contents = await readFile(ENV_LOCAL_PATH, "utf8");
  }
  const lines = contents.length > 0 ? contents.split("\n") : [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^DATABASE_URL=/.test(line)) {
      lines[i] = `DATABASE_URL="${cs}"`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`DATABASE_URL="${cs}"`);
  }
  await writeFile(ENV_LOCAL_PATH, lines.join("\n"), "utf8");
}
