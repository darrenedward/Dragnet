import { describe, expect, it } from "vitest";
import { EXECUTION_EVIDENCE_LIMIT, redactExecutionEvidence, sanitizeToolchainMetadata } from "../src/services/deterministicChecks/executionEvidence";

describe("execution evidence", () => {
  it("redacts secrets and caps each output", () => {
    const result = redactExecutionEvidence({
      phase: "install", command: "curl -H 'Authorization: Bearer live-token'", cwd: ".",
      status: "failed", exitCode: 1, signal: null, timedOut: false, retryCount: 2,
      stdout: "x".repeat(EXECUTION_EVIDENCE_LIMIT + 100), stderr: "password=secret",
      startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
    }, ["live-token", "secret"]);
    expect(result.commandId).toHaveLength(24);
    expect(result.command).toContain("[REDACTED]");
    expect(result.stderr).not.toContain("secret");
    expect(result.stdout).toContain("[truncated]");
  });

  it("drops credential-shaped toolchain metadata", () => {
    expect(sanitizeToolchainMetadata({ ecosystem: "node", pat: "secret", nested: { password: "x", ok: true } }))
      .toEqual({ ecosystem: "node", nested: { ok: true } });
  });
});
