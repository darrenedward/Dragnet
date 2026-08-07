import { describe, it, expect } from "vitest";
import {
  externalDependencySkipFinding,
  isExternalDependencyFailure,
  redactExternalDependencyOutput,
  skippedFinding,
  shouldRunHostTier1,
  DEFAULT_TEST_COMMAND,
  DEFAULT_INSTALL_COMMAND,
  resolveQualityCommand,
} from "@/src/services/deterministicChecks/helpers";

describe("external dependency classification", () => {
  it("recognizes NWATrade-shaped localhost PostgreSQL refusal", () => {
    expect(isExternalDependencyFailure("AggregateError: connect ECONNREFUSED 127.0.0.1:5433")).toBe(true);
  });

  it("does not classify ordinary compiler diagnostics as external", () => {
    expect(isExternalDependencyFailure("src/app.ts(4,2): error TS2322: Type 'string' is not assignable to type 'number'.")).toBe(false);
  });

  it("creates a non-code skip with provenance", () => {
    expect(externalDependencySkipFinding("runner", "database unavailable", "stderr: ECONNREFUSED")).toMatchObject({
      kind: "external_dependency_skip",
      filename: "<external-dependency>",
      category: "External Dependency Skipped",
      provenance: "stderr: ECONNREFUSED",
    });
  });

  it("redacts credentials from external-service telemetry", () => {
    expect(redactExternalDependencyOutput("postgresql://user:secret@db:5432/app password=topsecret")).toBe(
      "postgresql://<redacted>@db:5432/app password=<redacted>",
    );
  });
});

describe("skippedFinding", () => {
  it("returns a DeterministicFinding with severity info and category Skipped", () => {
    const result = skippedFinding("eslint", "node_modules/ missing");
    expect(result.severity).toBe("info");
    expect(result.category).toBe("Skipped");
    expect(result.filename).toBe("<tooling>");
    expect(result.line).toBeNull();
    expect(result.source).toBe("eslint");
    expect(result.explanation).toBe("[eslint] node_modules/ missing");
  });

  it("prepends source tag to message", () => {
    const result = skippedFinding("tsc", "timeout after 60s");
    expect(result.explanation).toBe("[tsc] timeout after 60s");
  });

  it("works with 'runner' source", () => {
    const result = skippedFinding("runner", "podman unavailable");
    expect(result.source).toBe("runner");
    expect(result.explanation).toBe("[runner] podman unavailable");
  });
});

describe("shouldRunHostTier1", () => {
  it("runs for local path-only checkout", () => {
    expect(shouldRunHostTier1({ path: "/home/dev/repo", cloneUrl: null, localPath: null })).toBe(true);
  });

  it("skips when path is missing", () => {
    expect(shouldRunHostTier1({ path: null, cloneUrl: null })).toBe(false);
    expect(shouldRunHostTier1(null)).toBe(false);
  });

  it("skips remote/volume-backed when cloneUrl is set even if path exists", () => {
    expect(
      shouldRunHostTier1({
        path: "/empty/host/mirror",
        cloneUrl: "https://github.com/acme/app.git",
        localPath: null,
      }),
    ).toBe(false);
  });

  it("skips volume container mode (localPath=/workspace)", () => {
    expect(
      shouldRunHostTier1({
        path: "/workspace",
        cloneUrl: null,
        localPath: "/workspace",
      }),
    ).toBe(false);
  });
});

describe("default quality-gate commands", () => {
  it("defaults test command to typecheck + lint (not e2e)", () => {
    expect(DEFAULT_TEST_COMMAND).toBe("npm run typecheck && npm run lint");
    expect(DEFAULT_TEST_COMMAND).not.toMatch(/\bnpm test\b/);
    expect(DEFAULT_INSTALL_COMMAND).toBe("npm install");
  });

  it("keeps the default quality gate free of broad test suites", () => {
    expect(resolveQualityCommand()).toBe("npm run typecheck && npm run lint");
  });

  it("uses build plus lint when the default command has no typecheck script", () => {
    expect(resolveQualityCommand({
      configuredCommand: DEFAULT_TEST_COMMAND,
      scripts: { build: "next build", lint: "eslint" },
    }))
      .toBe("npm run build && npm run lint");
  });

  it("accepts a verified repository-specific quality command", () => {
    expect(resolveQualityCommand({ configuredCommand: "npm run build && npm run lint" }))
      .toBe("npm run build && npm run lint");
  });

  it("replaces a broad test override with the safe quality path", () => {
    expect(resolveQualityCommand({
      configuredCommand: "npm test && npm run lint",
      scripts: { build: "next build", lint: "eslint" },
    })).toBe("npm run build && npm run lint");
  });

  it("does not fall back to npm test when typecheck is unavailable", () => {
    expect(resolveQualityCommand({
      configuredCommand: DEFAULT_TEST_COMMAND,
      scripts: { build: "npm run build", lint: "eslint" },
    }))
      .not.toMatch(/npm (run )?test/);
  });

  it("uses lint alone when neither typecheck nor build is available", () => {
    expect(resolveQualityCommand({
      configuredCommand: DEFAULT_TEST_COMMAND,
      scripts: { lint: "eslint" },
    })).toBe("npm run lint");
  });
});
