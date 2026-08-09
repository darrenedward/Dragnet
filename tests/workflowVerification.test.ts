import { describe, expect, it } from "vitest";
import { VERIFICATION_MATRIX, verifyLocalMatrix } from "../scripts/verify-deterministic-workflow.mts";

describe("deterministic workflow verification matrix", () => {
  it("covers the required ecosystem and service-backed fixtures", () => {
    expect(VERIFICATION_MATRIX.map((fixture) => fixture.ecosystem)).toEqual(["node", "python", "go", "rust", "node"]);
    expect(VERIFICATION_MATRIX.some((fixture) => fixture.requiresService === "postgres")).toBe(true);
  });

  it("resolves every local fixture with a deterministic fingerprint", () => {
    const results = verifyLocalMatrix();
    expect(results).toHaveLength(5);
    expect(results.every((result) => result.status === "resolved" && result.fingerprint.length === 64)).toBe(true);
  });
});
