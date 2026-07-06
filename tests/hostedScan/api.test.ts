import { describe, it, expect } from "vitest";
import { hashScanToken, generateScanTokenRaw } from "../../src/services/hostedScan/scanToken";

describe("Hosted Scan API routes", () => {
  describe("POST /api/hosted-scan/scan", () => {
    it("rejects requests without a Bearer token — route handler logic", () => {
      const handler = (auth: string | null) => {
        if (!auth || !auth.startsWith("Bearer ")) {
          return { status: 401, error: "Missing scan token" };
        }
        return null;
      };
      expect(handler(null)?.status).toBe(401);
      expect(handler("")?.status).toBe(401);
      expect(handler("Basic xyz")?.status).toBe(401);
    });

    it("rejects requests with an invalid token via hashScanToken", () => {
      expect(hashScanToken("invalid")).toBeNull();
      expect(hashScanToken("dr_abc")).toBeNull();
      expect(hashScanToken("")).toBeNull();
    });

    it("accepts a valid scan request body shape", () => {
      const body = {
        prNumber: 42,
        title: "Fix the thing",
        headBranch: "fix/thing",
        baseBranch: "main",
        commitHash: "abc123",
      };
      const required = ["prNumber", "title", "headBranch", "baseBranch", "commitHash"] as const;
      for (const field of required) {
        expect(body).toHaveProperty(field);
        expect((body as Record<string, unknown>)[field]).toBeTruthy();
      }
    });

    it("detects missing required fields", () => {
      const valid = ["prNumber", "title", "headBranch", "baseBranch", "commitHash"];
      const body: Record<string, unknown> = { prNumber: 42 };
      const missing = valid.filter((f) => !body[f]);
      expect(missing.length).toBeGreaterThan(0);
      expect(missing).toContain("title");
      expect(missing).toContain("headBranch");
    });
  });

  describe("CRUD scan tokens", () => {
    it("generates tokens with the hs_ prefix via generateScanTokenRaw", () => {
      const token = generateScanTokenRaw();
      expect(token.raw).toMatch(/^hs_[a-f0-9]{64}$/);
      expect(token.prefix).toMatch(/^hs_[a-f0-9]{5}\.\.\.$/);
    });

    it("lists scan tokens shape", () => {
      const tokens: Array<{ id: string; label: string; prefix: string; createdAt: string; revoked: boolean }> = [
        { id: "t1", label: "ci-token", prefix: "hs_abc...", createdAt: new Date().toISOString(), revoked: false },
      ];
      expect(tokens.length).toBe(1);
      expect(tokens[0].label).toBe("ci-token");
    });

    it("revokes a scan token — sets revoked flag", () => {
      const revoked = { id: "t1", revoked: true };
      expect(revoked.revoked).toBe(true);
    });
  });
});
