import { describe, expect, it } from "vitest";
import {
  resolveToolchain,
  resolveToolchainFromReader,
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
    expect(result.execution.installCommand).toBe("corepack pnpm@9.15.0 install --frozen-lockfile");
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

  it.each([
    ["Poetry", { "pyproject.toml": "[tool.poetry]\n", "poetry.lock": "[[package]]\n" }, "poetry install --no-root"],
    ["requirements", { "requirements.txt": "pytest==8.3.0\n" }, "python -m pip install -r requirements.txt"],
  ])("resolves the Python %s workflow", (_name, files, install) => {
    const result = resolveToolchain({ tip: tip(files) });
    expect(result.status).toBe("resolved");
    expect(result.identity?.ecosystem).toBe("python");
    expect(result.execution.installCommand).toBe(install);
    expect(result.execution.qualityCommands).toEqual(["python -m pytest"]);
  });

  it("uses a compatible Node image for an upper-bound runtime", () => {
    const result = resolveToolchain({
      tip: tip({ "package.json": JSON.stringify({ engines: { node: "<20" } }), "package-lock.json": "{}" }),
    });
    expect(result.execution.image).toBe("node:18-alpine");
  });

  it("enforces a declared npm Corepack version", () => {
    const result = resolveToolchain({
      tip: tip({ "package.json": JSON.stringify({ packageManager: "npm@10.8.2" }), "package-lock.json": "{}" }),
    });
    expect(result.execution.installCommand).toBe("corepack npm@10.8.2 ci");
  });

  it("enforces a declared Yarn Corepack version", () => {
    const result = resolveToolchain({
      tip: tip({ "package.json": JSON.stringify({ packageManager: "yarn@4.5.0" }), "yarn.lock": "__metadata:\n" }),
    });
    expect(result.execution.installCommand).toBe("corepack yarn@4.5.0 install --immutable");
  });

  it("rejects PHP constraints that the pinned Composer runtime cannot satisfy", () => {
    const result = resolveToolchain({
      tip: tip({ "composer.json": JSON.stringify({ require: { php: "<8.3" } }), "composer.lock": "{}" }),
    });
    expect(result.status).toBe("ambiguous");
    expect(result.execution.image).toBe("composer:2.8");
    expect(result.conflicts[0]).toContain("incompatible");
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

  it.each([
    ["go", { "go.mod": "module example\ngo 1.22\n", "go.sum": "hash" }, "golang:1.22-alpine", "go mod download", "go test ./..."],
    ["rust", { "Cargo.toml": "[package]\nname = \"example\"\n", "Cargo.lock": "version = 3\n", "rust-toolchain.toml": "channel = \"1.80\"\n" }, "rust:1.80-slim", "cargo check --locked", "cargo test --locked"],
    ["ruby", { Gemfile: "source \"https://rubygems.org\"\n", "Gemfile.lock": "GEM\n", ".ruby-version": "3.3\n" }, "ruby:3.3-alpine", "bundle install --deployment", "bundle exec ruby -Itest"],
    ["php", { "composer.json": JSON.stringify({ require: { php: ">=8.2" } }), "composer.lock": "{}" }, "composer:2.8", "composer install --no-interaction --prefer-dist --no-progress", "composer check-platform-reqs"],
  ])("resolves the %s adapter with a locked command", (_name, files, image, install, quality) => {
    const result = resolveToolchain({ tip: tip(files) });
    expect(result.status).toBe("resolved");
    expect(result.execution.image).toBe(image);
    expect(result.execution.installCommand).toBe(install);
    expect(result.execution.qualityCommands).toEqual([quality]);
  });

  it("reports missing non-Node lockfiles without selecting Node", () => {
    const result = resolveToolchain({ tip: tip({ "Cargo.toml": "[package]\nname=\"x\"\n" }) });
    expect(result.status).toBe("ambiguous");
    expect(result.identity?.ecosystem).toBe("rust");
    expect(result.execution.image).not.toContain("node");
    expect(result.execution.installCommand).toBeNull();
  });

  it("rejects repository overrides that conflict with the detected package manager", () => {
    const result = resolveToolchain({
      tip: tip({ "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }),
      repositoryOverrides: { runnerImage: "node:20-alpine", installCommand: "npm install" },
    });
    expect(result.status).toBe("ambiguous");
    expect(result.conflicts).toContain("Repository installCommand conflicts with the resolved pnpm toolchain");
    expect(result.execution.installCommand).toBe("corepack pnpm install --frozen-lockfile");
  });

  it("resolves a manifest through a tip reader without filesystem access", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ packageManager: "pnpm@9.15.0", scripts: { test: "pnpm test" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    };
    const result = await resolveToolchainFromReader({
      headSha: "b".repeat(40),
      source: "remote-volume",
      readFile: async (path) => files[path] ?? null,
    });
    expect(result.status).toBe("resolved");
    expect(result.tip.source).toBe("remote-volume");
    expect(result.execution.installCommand).toContain("pnpm@9.15.0 install --frozen-lockfile");
  });
});
