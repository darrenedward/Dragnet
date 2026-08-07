import { describe, expect, it } from "vitest";
import {
  classifyScanTerminalOutcome,
  outcomeFromScanResult,
  prStatusForTerminal,
  providerOutcomesFromTokensUsed,
  runPersistForTerminal,
} from "../src/lib/scanTerminalOutcome";

describe("classifyScanTerminalOutcome", () => {
  it("keeps processing while queue running (no Complete flash)", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Failed",
      runStatus: "failed",
      queueState: "running",
      queuePosition: 1,
    });
    expect(o.isProcessing).toBe(true);
    expect(o.uiStatusKind).toBe("processing");
    expect(o.isFailed).toBe(false);
  });

  it("surfaces queue wait reason with position and slots", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Pending",
      queueState: "queued",
      queuePosition: 3,
      queueSlots: { globalLimit: 2, repoLimit: 1 },
    });
    expect(o.class).toBe("queued");
    expect(o.reasonKind).toBe("queue");
    expect(o.reason).toMatch(/#3/);
    expect(o.reason).toMatch(/global concurrent slot/);
    expect(o.reason).toMatch(/repo limit 1/);
    expect(o.uiStatusKind).toBe("processing");
  });

  it("hard fail → Failed + quality reason + Re-scan CTA", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Failed",
      runStatus: "failed",
      terminalClass: "hard_fail",
      systemWarn: "hard_fail: primary and secondary quality_failure",
      providerOutcomes: ["quality_failure", "quality_failure"],
    });
    expect(o.isFailed).toBe(true);
    expect(o.uiStatusKind).toBe("failed");
    expect(o.label).toBe("Failed");
    expect(o.class).toBe("hard_fail");
    expect(o.reasonKind).toBe("quality");
    expect(o.primaryCta).toBe("rescan");
    expect(o.isEarnedSuccess).toBe(false);
    expect(prStatusForTerminal(o)).toBe("Failed");
  });

  it("quality_failure / null rating after AI is visibly failed not silent success", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Completed",
      runStatus: "completed",
      runOutcome: "reviewed",
      rating: null,
      systemWarn: "Model ended without calling submitReview",
      providerOutcomes: ["quality_failure"],
    });
    expect(o.isFailed).toBe(true);
    expect(o.uiStatusKind).toBe("failed");
    expect(o.class).toBe("quality_failure");
    expect(o.isEarnedSuccess).toBe(false);
    expect(o.primaryCta).toBe("rescan");
  });

  it("earned success with rating is Completed", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Completed",
      runStatus: "completed",
      runOutcome: "reviewed",
      rating: 8,
    });
    expect(o.class).toBe("success");
    expect(o.uiStatusKind).toBe("completed");
    expect(o.isEarnedSuccess).toBe(true);
    expect(o.isFailed).toBe(false);
    expect(prStatusForTerminal(o)).toBe("Completed");
  });

  it("preserves external dependency skip telemetry on an earned LLM result", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Completed",
      runStatus: "completed",
      runOutcome: "reviewed",
      rating: 8,
      systemWarn: "1 external project service check(s) skipped; deterministic quality status is unavailable",
    });

    expect(o.class).toBe("success");
    expect(o.isEarnedSuccess).toBe(true);
    expect(o.externalDependencySkipped).toBe(true);
  });

  it("skipped is completed lifecycle but not earned AI pass", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Completed",
      runStatus: "completed",
      runOutcome: "skipped",
      rating: null,
      usedModel: "none (skipped)",
    });
    expect(o.class).toBe("skipped");
    expect(o.isEarnedSuccess).toBe(false);
    expect(o.isFailed).toBe(false);
    expect(prStatusForTerminal(o)).toBe("Completed");
  });

  it("gate_blocked shows Failed with gate reason", () => {
    const o = classifyScanTerminalOutcome({
      prStatus: "Pending",
      blockedGate: "CLONE_FAILED",
      systemWarn: "clone failed",
    });
    expect(o.class).toBe("gate_blocked");
    expect(o.reasonKind).toBe("gate");
    expect(o.isFailed).toBe(true);
  });

  it("transport_failure distinguished from quality", () => {
    const o = classifyScanTerminalOutcome({
      success: false,
      systemWarn: "ECONNRESET from provider",
      providerOutcomes: ["transport_failure"],
    });
    expect(o.class).toBe("transport_failure");
    expect(o.reasonKind).toBe("transport");
    expect(o.primaryCta).toBe("rescan");
  });

  it("infrastructure_failure from flag", () => {
    const o = outcomeFromScanResult({
      success: false,
      infrastructureFailure: true,
      systemWarn: "Infrastructure failure in step install",
    });
    expect(o.class).toBe("infrastructure_failure");
    expect(o.reasonKind).toBe("infrastructure");
  });
});

describe("outcomeFromScanResult + persist helpers", () => {
  it("maps soft-fail HTTP body to failed persist shape", () => {
    const o = outcomeFromScanResult({
      success: false,
      rating: null,
      systemWarn: "ended the agentic loop without calling submitReview",
      providerOutcomes: ["quality_failure", "quality_failure"],
    });
    expect(o.isFailed).toBe(true);
    const persist = runPersistForTerminal(o);
    expect(persist.status).toBe("failed");
    expect(persist.terminalClass).toMatch(/quality_failure|hard_fail/);
    expect(prStatusForTerminal(o)).toBe("Failed");
  });

  it("extracts provider outcomes from tokensUsed", () => {
    expect(
      providerOutcomesFromTokensUsed({
        providers: [
          { name: "a", outcome: "quality_failure" },
          { name: "b", outcome: "transport_failure" },
        ],
      }),
    ).toEqual(["quality_failure", "transport_failure"]);
  });
});
