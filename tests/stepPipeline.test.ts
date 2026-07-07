import { describe, expect, it, vi } from "vitest";
import { StepError } from "../src/services/stepPipeline/types";
import { withRetry } from "../src/services/stepPipeline/retry";
import { StepPipeline } from "../src/services/stepPipeline/stepPipeline";
import type { DeterministicFinding } from "../src/services/deterministicChecks";

// ---------------------------------------------------------------------------
// StepError
// ---------------------------------------------------------------------------
describe("StepError", () => {
  it("sets name and isInfrastructure flag", () => {
    const err = new StepError("disk full", true);
    expect(err.name).toBe("StepError");
    expect(err.message).toBe("disk full");
    expect(err.isInfrastructure).toBe(true);
  });

  it("sets isInfrastructure to false for code errors", () => {
    const err = new StepError("tsc exited with code 2", false);
    expect(err.isInfrastructure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------
describe("withRetry", () => {
  it("returns ok result on first success", async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, data: 42 });
    const result = await withRetry(fn, { maxRetries: 2, stepName: "test" });

    expect(result.ok).toBe(true);
    expect(result.data).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on infrastructure error up to maxRetries", async () => {
    const infraErr = new StepError("network down", true);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: infraErr })
      .mockResolvedValueOnce({ ok: false, error: infraErr })
      .mockResolvedValueOnce({ ok: true, data: "recovered" });

    const result = await withRetry(fn, { maxRetries: 2, stepName: "test" });

    expect(result.ok).toBe(true);
    expect(result.data).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-infrastructure errors", async () => {
    const codeErr = new StepError("compile error", false);
    const fn = vi.fn().mockResolvedValue({ ok: false, error: codeErr });

    const result = await withRetry(fn, { maxRetries: 2, stepName: "test" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(codeErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns error after exhausting retries", async () => {
    const infraErr = new StepError("container crash", true);
    const fn = vi.fn().mockResolvedValue({ ok: false, error: infraErr });

    const result = await withRetry(fn, { maxRetries: 2, stepName: "container" });

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry callback on each retry", async () => {
    const infraErr = new StepError("timeout", true);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: infraErr })
      .mockResolvedValueOnce({ ok: true, data: "ok" });
    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 2, stepName: "test", onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, infraErr);
  });

  it("recovers after one retry", async () => {
    const infraErr = new StepError("transient", true);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: infraErr })
      .mockResolvedValueOnce({ ok: true, data: "ok" });

    const result = await withRetry(fn, { maxRetries: 3, stepName: "test" });

    expect(result.ok).toBe(true);
    expect(result.data).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("handles thrown errors as infrastructure errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await withRetry(fn, { maxRetries: 1, stepName: "test" });

    expect(result.ok).toBe(false);
    expect(result.error?.isInfrastructure).toBe(true);
    expect(result.error?.message).toContain("ECONNREFUSED");
  });

  it("recovers after a thrown infrastructure error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, data: "recovered" });

    const result = await withRetry(fn, { maxRetries: 2, stepName: "test" });

    expect(result.ok).toBe(true);
    expect(result.data).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("with maxRetries 0 never retries infrastructure errors", async () => {
    const infraErr = new StepError("broken", true);
    const fn = vi.fn().mockResolvedValue({ ok: false, error: infraErr });

    const result = await withRetry(fn, { maxRetries: 0, stepName: "test" });

    expect(result.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// StepPipeline
// ---------------------------------------------------------------------------
describe("StepPipeline", () => {
  it("runs a single step and returns its data", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "step1",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("f1")] }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].explanation).toBe("f1");
  });

  it("runs steps in order and accumulates findings", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "tsc",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("tsc error")] }),
    });
    pipeline.addStep({
      name: "eslint",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("eslint warning")] }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.explanation).sort()).toEqual([
      "eslint warning",
      "tsc error",
    ]);
  });

  it("collects findings from non-critical code errors and continues", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "tsc",
      critical: false,
      maxRetries: 0,
      fn: async () => ({
        ok: false,
        error: new StepError("tsc exited 2", false),
        findings: [mkFinding("compile error")],
      }),
    });
    pipeline.addStep({
      name: "eslint",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("lint ok")] }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(2);
  });

  it("aborts on infrastructure error after retries", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "container",
      critical: false,
      maxRetries: 1,
      fn: vi.fn().mockResolvedValue({
        ok: false,
        error: new StepError("docker daemon down", true),
      }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(true);
    expect(result.infrastructureFailure).toBe(true);
    expect(result.lastStepName).toBe("container");
  });

  it("aborts on critical non-infrastructure error", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "llm",
      critical: true,
      maxRetries: 0,
      fn: async () => ({
        ok: false,
        error: new StepError("model refused", false),
      }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(true);
    expect(result.infrastructureFailure).toBe(false);
    expect(result.lastStepName).toBe("llm");
  });

  it("does NOT run remaining steps after abort", async () => {
    const step2 = vi.fn();
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "step1",
      critical: false,
      maxRetries: 0,
      fn: async () => ({
        ok: false,
        error: new StepError("infra fail", true),
      }),
    });
    pipeline.addStep({
      name: "step2",
      critical: false,
      maxRetries: 0,
      fn: step2,
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(true);
    expect(step2).not.toHaveBeenCalled();
  });

  it("preserves step results in stepResults array", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "step1",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: ["a"] }),
    });

    const result = await pipeline.run();

    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].stepName).toBe("step1");
    expect(result.stepResults[0].result.ok).toBe(true);
  });

  it("retries step on infrastructure error when maxRetries > 0", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: new StepError("transient", true) })
      .mockResolvedValueOnce({ ok: true, data: [mkFinding("found")] });

    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "retry-step",
      critical: false,
      maxRetries: 1,
      fn,
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("handles skipTier2 equivalent (step that returns ok immediately)", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "tier2",
      critical: false,
      maxRetries: 2,
      fn: async () => ({ ok: true, data: [] as DeterministicFinding[] }),
    });

    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("returns empty findings when no steps added", async () => {
    const pipeline = new StepPipeline();
    const result = await pipeline.run();

    expect(result.aborted).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.stepResults).toHaveLength(0);
  });

  it("allows multiple addStep calls before run", async () => {
    const pipeline = new StepPipeline();
    pipeline.addStep({
      name: "a",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("a")] }),
    });
    pipeline.addStep({
      name: "b",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("b")] }),
    });
    pipeline.addStep({
      name: "c",
      critical: false,
      maxRetries: 0,
      fn: async () => ({ ok: true, data: [mkFinding("c")] }),
    });

    const result = await pipeline.run();

    expect(result.stepResults).toHaveLength(3);
    expect(result.findings).toHaveLength(3);
  });
});

function mkFinding(explanation: string): DeterministicFinding {
  return {
    filename: "test.ts",
    line: 1,
    severity: "error",
    category: "correctness",
    explanation,
    source: "tsc",
  };
}
