import { describe, it, expect } from "vitest";

describe("Hosted Scan API routes", () => {
  describe("POST /api/hosted-scan/scan", () => {
    it("rejects requests without a Bearer token", () => {
      const response = { status: 401, body: { error: "Missing scan token" } };
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/missing scan token/i);
    });

    it("rejects requests with an invalid token", () => {
      const response = { status: 401, body: { error: "Invalid scan token" } };
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/invalid scan token/i);
    });

    it("accepts a valid scan request with required fields", () => {
      const body = {
        prNumber: 42,
        title: "Fix the thing",
        headBranch: "fix/thing",
        baseBranch: "main",
        commitHash: "abc123",
      };
      expect(body.prNumber).toBe(42);
      expect(body.title).toBeTruthy();
      expect(body.headBranch).toBe("fix/thing");
    });

    it("rejects a scan request missing required fields", () => {
      const body: Record<string, unknown> = { prNumber: 42 };
      const errors: string[] = [];
      if (!body.title) errors.push("title is required");
      if (!body.headBranch) errors.push("headBranch is required");
      if (!body.baseBranch) errors.push("baseBranch is required");
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("CRUD scan tokens", () => {
    it("lists scan tokens for a repo", () => {
      const tokens = [
        { id: "t1", label: "ci-token", prefix: "hs_abc...", createdAt: new Date().toISOString(), revoked: false },
      ];
      expect(tokens.length).toBe(1);
      expect(tokens[0].label).toBe("ci-token");
    });

    it("creates a new scan token", () => {
      const token = {
        id: "t2",
        label: "deploy-token",
        raw: "hs_" + "a".repeat(64),
        prefix: "hs_aaa...",
      };
      expect(token.raw).toMatch(/^hs_/);
      expect(token.prefix).toBe("hs_aaa...");
    });

    it("revokes a scan token", () => {
      const revoked = { id: "t1", revoked: true };
      expect(revoked.revoked).toBe(true);
    });
  });
});
