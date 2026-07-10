import { describe, it, expect } from "vitest";
import { skippedFinding } from "@/src/services/deterministicChecks/helpers";

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
