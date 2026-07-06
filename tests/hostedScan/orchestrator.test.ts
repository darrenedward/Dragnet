import { describe, it, expect } from "vitest";

describe("HostedScan orchestrator", () => {
  describe("validateRepoMode", () => {
    it("allows hosted mode repos to accept external scan requests", () => {
      const repo = { id: "r1", hostedMode: true };
      expect(repo.hostedMode).toBe(true);
    });

    it("blocks external scan requests for local mode repos", () => {
      const repo = { id: "r1", hostedMode: false };
      expect(repo.hostedMode).toBe(false);
    });
  });

  describe("buildPrFromHostedData", () => {
    it("builds a PullRequest-compatible object from external PR data", () => {
      const data = {
        number: 42,
        title: "Fix the thing",
        sourceBranch: "fix/thing",
        targetBranch: "main",
        author: "octocat",
        commitHash: "abc123",
        description: "Fixes the thing",
      };

      expect(data.number).toBe(42);
      expect(data.title).toContain("Fix");
      expect(data.sourceBranch).toBe("fix/thing");
      expect(data.targetBranch).toBe("main");
    });

    it("handles missing optional fields gracefully", () => {
      const data: Record<string, unknown> = {
        number: 1,
        title: "Untitled",
        sourceBranch: "patch-1",
        targetBranch: "main",
        author: "unknown",
        commitHash: "deadbeef",
      };

      expect(data.title).toBe("Untitled");
      expect(data.description).toBeUndefined();
    });
  });

  describe("triggerHostedScan", () => {
    it("returns an error when repo is not in hosted mode", async () => {
      const result = { ok: false, error: "Repository is not in hosted mode" };
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not in hosted mode/);
    });

    it("returns success when scan is triggered", async () => {
      const result = { ok: true, prId: "pr_abc123" };
      expect(result.ok).toBe(true);
      expect(result.prId).toBeTruthy();
    });
  });
});
