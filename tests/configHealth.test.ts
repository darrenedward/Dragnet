import { describe, expect, it } from "vitest";
import { getConfigHealth } from "../src/lib/configHealth";

const VALID_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

function itemIds(env: Record<string, string | undefined>): string[] {
  return getConfigHealth(env).items.map((item) => item.id);
}

describe("getConfigHealth", () => {
  it("reports setup-needed env without throwing", () => {
    const report = getConfigHealth({});

    expect(report.ok).toBe(false);
    expect(report.status).toBe("needs_setup");
    expect(itemIds({})).toEqual(["database-url", "master-key"]);
  });

  it("accepts a minimal configured environment", () => {
    const report = getConfigHealth({
      DATABASE_URL: "postgresql://postgres:secret@localhost:5432/dragnet",
      DRAGNET_MASTER_KEY: VALID_MASTER_KEY,
    });

    expect(report.ok).toBe(true);
    expect(report.items).toEqual([]);
  });

  it("flags placeholder and malformed required values", () => {
    const report = getConfigHealth({
      DATABASE_URL: "postgresql://USER:PASSWORD@HOST:5432/postgres",
      DRAGNET_MASTER_KEY: "not-32-bytes",
    });

    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "database-url", status: "invalid" }),
        expect.objectContaining({ id: "master-key", status: "invalid" }),
      ]),
    );
  });

  it("requires DRAGNET_API_KEY only when polling is enabled", () => {
    expect(
      itemIds({
        DATABASE_URL: "postgresql://postgres:secret@localhost:5432/dragnet",
        DRAGNET_MASTER_KEY: VALID_MASTER_KEY,
      }),
    ).not.toContain("polling-api-key");

    expect(
      itemIds({
        DATABASE_URL: "postgresql://postgres:secret@localhost:5432/dragnet",
        DRAGNET_MASTER_KEY: VALID_MASTER_KEY,
        DRAGNET_POLLING_ENABLED: "1",
      }),
    ).toContain("polling-api-key");
  });

  it("flags partial GitHub App configuration", () => {
    const report = getConfigHealth({
      DATABASE_URL: "postgresql://postgres:secret@localhost:5432/dragnet",
      DRAGNET_MASTER_KEY: VALID_MASTER_KEY,
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "client-id",
      DRAGNET_PUBLIC_URL: "https://dragnet.example.com",
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        id: "github-app",
        severity: "warning",
        variables: ["GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"],
      }),
    ]);
  });
});
