import { describe, expect, it } from "vitest";
import { planQualityChecks, buildTimeEnvironment } from "../src/services/deterministicChecks/qualityPlan";
import { createDisposableServicePlan, withDisposableServices } from "../src/services/deterministicChecks/disposableServices";

const command = (kind: "static" | "unit" | "integration" | "e2e", requiresServices: string[] = []) => ({
  kind, command: `${kind} command`, cwd: ".", environment: { BUILD_DATABASE_URL: "synthetic", SECRET: "must-not-pass" }, buildTimeEnvironment: ["BUILD_DATABASE_URL"], requiresServices, optional: requiresServices.length > 0,
});

describe("quality planning", () => {
  it("keeps static checks runnable when an optional service is unavailable", () => {
    const result = planQualityChecks({
      static: [command("static")], unit: [command("unit")], integration: [command("integration", ["postgres"])], e2e: [],
    }, new Set());
    expect(result.map((item) => item.status)).toEqual(["passed", "passed", "skipped_dependency"]);
    expect(result[2].reason).toContain("postgres");
    expect(buildTimeEnvironment(result[0].command)).toEqual({ BUILD_DATABASE_URL: "synthetic" });
    expect(buildTimeEnvironment({ ...result[0].command, environment: { SECRET: "no" }, buildTimeEnvironment: ["SECRET"] })).toEqual({ SECRET: "no" });
  });
});

describe("disposable service lifecycle", () => {
  it("requires pinned images and creates scan-isolated resources", () => {
    expect(() => createDisposableServicePlan("scan/1", [{ name: "db", image: "postgres:latest", alias: "db", healthcheck: { command: ["pg_isready"] } }])).toThrow("version-pinned");
    const plan = createDisposableServicePlan("scan/1", [{ name: "db", image: "postgres:16.4", alias: "db", sqlite: true, healthcheck: { command: ["pg_isready"] } }]);
    expect(plan.networkName).toContain("dragnet-scan-scan-1");
    expect(plan.services[0].volumeName).toContain("scan-1-db");
    expect(plan.services[0].sqlitePath).toContain("/tmp/dragnet-scan-scan-1/");
  });

  it("cleans started services and the network after command failure", async () => {
    const plan = createDisposableServicePlan("abc", [{ name: "db", image: "postgres:16.4", alias: "db", healthcheck: { command: ["pg_isready"] } }]);
    const calls: string[] = [];
    const result = await withDisposableServices(plan, {
      start: async () => { calls.push("start"); },
      stop: async () => { calls.push("stop"); },
      removeNetwork: async () => { calls.push("network"); },
    }, async () => { throw new Error("check failed"); });
    expect(result.lifecycle.errors).toContain("check failed");
    expect(calls).toEqual(["start", "stop", "network"]);
    expect(result.lifecycle.cleaned).toEqual(["db"]);
  });
});
