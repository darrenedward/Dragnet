import { describe, expect, it } from "vitest";
import {
  resolveToolchain,
  type TipTreeManifest,
} from "../src/services/deterministicChecks/toolchainResolver";

function tip(files: Record<string, string>, source: TipTreeManifest["source"] = "pr-tip"):
  TipTreeManifest {
  return { headSha: "a".repeat(40), source, files };
}

describe("resolveToolchain", () => {
  it("resolves Node from the PR tip and prefers the matching lockfile", () => {
    const result = resolveToolchain({
      tip: tip({
        "package.json": JSON.stringify({
          name: "web",
          packageManager: "pnpm@9.15.0",
          engines: { node: ">=20" },
          scripts: { build: "vite build", test: "vitest run" },
        }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      }),
    });

    expect(result.status).toBe("resolved");
    expect(result.identity).toMatchObject({
      ecosystem: "node",
      lockfiles: ["pnpm-lock.yaml"],
      packageManager: { name: "pnpm", version: "9.15.0" },
      runtime: { node: ">=20" },
    });
    expect(result.execution.installCommand).toBe("corepack pnpm install --frozen-lockfile");
    expect(result.execution.qualityCommands).toEqual(["vite build", "vitest run"]);
    expect(result.configuration.workspace).toBe(".");
    expect(result.identity.database).toBe("none");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps configurable workspace and checks separate from project identity", () => {
    const result = resolveToolchain({
      tip: tip({
        "package.json": JSON.stringify({ name: "workspace", scripts: { lint: "eslint ." } }),
        "package-lock.json": "{}",
        "packages/app/package.json": JSON.stringify({ name: "app" }),
      }),
      configuration: {
        workspace: "packages/app",
        qualityCommands: ["npm run lint"],
      },
    });

    expect(result.status).toBe("resolved");
    expect(result.identity.ecosystem).toBe("node");
    expect(result.configuration).toEqual({
      workspace: "packages/app",
      qualityCommands: ["npm run lint"],
    });
    expect(result.identity).not.toHaveProperty("workspace");
    expect(result.execution.qualityCommands).toEqual(["npm run lint"]);
  });

  it("reports conflicting lockfiles instead of selecting a generic fallback", () => {
    const result = resolveToolchain({
      tip: tip({
        "package.json": JSON.stringify({ name: "conflict" }),
        "package-lock.json": "{}",
        "yarn.lock": "__metadata:\n",
      }),
    });

    expect(result.status).toBe("ambiguous");
    expect(result.conflicts).toContain("Multiple Node lockfiles detected");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports conflicting runtime declarations and refuses an unlocked Node install", () => {
    const result = resolveToolchain({
      tip: tip({
        "package.json": JSON.stringify({ engines: { node: ">=20" } }),
        ".nvmrc": "18\n",
      }),
    });

    expect(result.status).toBe("ambiguous");
    expect(result.conflicts).toContain("Node runtime declarations conflict: engines.node=>=20 vs version file=18");
    expect(result.execution.installCommand).toBeNull();
  });

  it("resolves a non-Node project and reports no database requirement", () => {
    const result = resolveToolchain({
      tip: tip({
        "pyproject.toml": "[project]\nrequires-python = \">=3.11\"\n",
        "uv.lock": "version = 1\n",
      }),
    });

    expect(result.status).toBe("resolved");
    expect(result.identity).toMatchObject({
      ecosystem: "python",
      lockfiles: ["uv.lock"],
      runtime: { python: ">=3.11" },
      database: "none",
    });
    expect(result.execution.installCommand).toBe("uv sync --locked");
  });

  it("returns actionable results for unsupported and empty projects", () => {
    const unsupported = resolveToolchain({ tip: tip({ "pom.xml": "<project/>" }) });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.conflicts[0]).toContain("Unsupported project");

    const empty = resolveToolchain({ tip: tip({}) });
    expect(empty.status).toBe("unsupported");
    expect(empty.conflicts[0]).toContain("No supported project declaration");
  });

  it("does not use a Composer command for an unlocked Python project", () => {
    const result = resolveToolchain({ tip: tip({ "pyproject.toml": "[project]\n" }) });
    expect(result.status).toBe("ambiguous");
    expect(result.execution.installCommand).toBeNull();
    expect(result.conflicts).toContain("No Python dependency lockfile detected");
  });

  it("changes the fingerprint when tip content changes, regardless of object order", () => {
    const first = resolveToolchain({ tip: tip({ "package-lock.json": "one", "package.json": "{}" }) });
    const same = resolveToolchain({ tip: tip({ "package.json": "{}", "package-lock.json": "one" }) });
    const changed = resolveToolchain({ tip: tip({ "package.json": "{}", "package-lock.json": "two" }) });
    expect(same.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("requires a PR-tip manifest and accepts a remote synced tip as the same source", () => {
    expect(() => resolveToolchain({ tip: tip({ "package.json": "{}" }, "remote-volume") })).not.toThrow();
    expect(() => resolveToolchain({ tip: { headSha: "a".repeat(40), source: "host-checkout", files: {} } })).toThrow(
      "PR tip tree",
    );
  });
});
