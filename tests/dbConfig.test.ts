import { describe, it, expect } from "vitest";
import {
  parseConnectionString,
  buildConnectionString,
  isSupabaseHost,
  viewFromEnv,
} from "../src/lib/dbConfig";

describe("parseConnectionString", () => {
  it("parses a standard postgres URL", () => {
    const r = parseConnectionString("postgresql://user:pass@localhost:5432/mydb");
    expect(r.host).toBe("localhost");
    expect(r.port).toBe("5432");
    expect(r.username).toBe("user");
    expect(r.password).toBe("pass");
    expect(r.database).toBe("mydb");
    expect(r.isSupabase).toBe(false);
  });

  it("detects Supabase by hostname", () => {
    const r = parseConnectionString(
      "postgresql://postgres.x:pass@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres",
    );
    expect(r.isSupabase).toBe(true);
    expect(r.port).toBe("6543");
  });

  it("defaults port to 6543 for Supabase when omitted", () => {
    const r = parseConnectionString("postgresql://u:p@db.supabase.com/postgres");
    expect(r.port).toBe("6543");
  });

  it("defaults port to 5432 for plain Postgres when omitted", () => {
    const r = parseConnectionString("postgresql://u:p@localhost/postgres");
    expect(r.port).toBe("5432");
  });

  it("returns empty fields for empty input", () => {
    const r = parseConnectionString("");
    expect(r.host).toBe("");
    expect(r.port).toBe("");
    expect(r.username).toBe("");
  });

  it("returns empty fields for unparseable input", () => {
    const r = parseConnectionString("not a url");
    expect(r.host).toBe("");
  });

  it("decodes URL-encoded credentials", () => {
    const r = parseConnectionString("postgresql://u%40x:p%23s@host:5432/db");
    expect(r.username).toBe("u@x");
    expect(r.password).toBe("p#s");
  });
});

describe("buildConnectionString", () => {
  it("uses host verbatim for Supabase dialect", () => {
    const cs = buildConnectionString({
      dialect: "supabase",
      host: "postgresql://postgres.x:pass@pooler.supabase.com:6543/postgres",
      port: "",
      username: "",
      password: "",
      database: "",
    });
    expect(cs).toBe("postgresql://postgres.x:pass@pooler.supabase.com:6543/postgres");
  });

  it("assembles a postgres URL from parts", () => {
    const cs = buildConnectionString({
      dialect: "postgresql",
      host: "localhost",
      port: "5432",
      username: "postgres",
      password: "secret",
      database: "dragnet",
    });
    expect(cs).toBe("postgresql://postgres:secret@localhost:5432/dragnet");
  });

  it("URL-encodes special characters in credentials", () => {
    const cs = buildConnectionString({
      dialect: "postgresql",
      host: "localhost",
      port: "5432",
      username: "u@x",
      password: "p#s",
      database: "db",
    });
    expect(cs).toBe("postgresql://u%40x:p%23s@localhost:5432/db");
  });

  it("omits auth when no username supplied", () => {
    const cs = buildConnectionString({
      dialect: "postgresql",
      host: "localhost",
      port: "5432",
      username: "",
      password: "",
      database: "db",
    });
    expect(cs).toBe("postgresql://localhost:5432/db");
  });
});

describe("isSupabaseHost", () => {
  it("matches pooler hostnames", () => {
    expect(isSupabaseHost("aws-1-ap-northeast-2.pooler.supabase.com")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isSupabaseHost("DB.SUPABASE.COM")).toBe(true);
  });
  it("rejects unrelated hosts", () => {
    expect(isSupabaseHost("localhost")).toBe(false);
    expect(isSupabaseHost("example.com")).toBe(false);
  });
});

describe("viewFromEnv", () => {
  it("returns unconfigured state when DATABASE_URL is empty", () => {
    const orig = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const v = viewFromEnv();
    expect(v.configured).toBe(false);
    expect(v.isSupabase).toBe(false);
    process.env.DATABASE_URL = orig;
  });

  it("detects Supabase when DATABASE_URL points at supabase.com", () => {
    const orig = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://postgres.x:pass@pooler.supabase.com:6543/postgres?sslmode=require";
    const v = viewFromEnv();
    expect(v.configured).toBe(true);
    expect(v.isSupabase).toBe(true);
    expect(v.dialect).toBe("supabase");
    expect(v.hasPassword).toBe(true);
    process.env.DATABASE_URL = orig;
  });
});
