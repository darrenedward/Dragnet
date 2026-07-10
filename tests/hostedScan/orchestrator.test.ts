import { describe, it, expect } from "vitest";
import type { HostedPrData, HostedScanResult } from "../../src/services/hostedScan/orchestrator";

describe("HostedScan orchestrator", () => {
  describe("HostedPrData type", () => {
    it("accepts valid PR data with all fields", () => {
      const data: HostedPrData = {
        prNumber: 42,
        title: "Fix the thing",
        headBranch: "fix/thing",
        baseBranch: "main",
        commitHash: "abc123",
        author: "octocat",
        description: "Fixes the thing",
      };
      expect(data.prNumber).toBe(42);
      expect(data.headBranch).toBe("fix/thing");
    });

    it("handles missing optional fields", () => {
      const data: HostedPrData = {
        prNumber: 1,
        title: "Untitled",
        headBranch: "patch-1",
        baseBranch: "main",
        commitHash: "deadbeef",
      };
      expect(data.description).toBeUndefined();
      expect(data.author).toBeUndefined();
    });
  });

  describe("HostedScanResult discriminated union", () => {
    it("discriminates error state", () => {
      const err: HostedScanResult = { ok: false, error: "Repository not found" };
      if (!err.ok) {
        expect(err.error).toMatch(/not found/);
      }
    });

    it("discriminates success state", () => {
      const ok: HostedScanResult = { ok: true, prId: "pr_abc123", runId: "run_xyz" };
      if (ok.ok) {
        expect(ok.prId).toBeTruthy();
        expect(ok.runId).toBeTruthy();
      }
    });

    it("runId is optional on success", () => {
      const ok: HostedScanResult = { ok: true, prId: "pr_xyz" };
      if (ok.ok) {
        expect(ok.runId).toBeUndefined();
      }
    });
  });
});
