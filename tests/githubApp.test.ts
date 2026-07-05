import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";

const RSA_KEY_B64 = execSync("openssl genrsa 2048 2>/dev/null", { encoding: "utf8" }).trim();
const RSA_KEY_B64_ENCODED = Buffer.from(RSA_KEY_B64).toString("base64");

describe("githubApp", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = RSA_KEY_B64_ENCODED;
    process.env.GITHUB_APP_CLIENT_ID = "Iv1.testclient";
    process.env.GITHUB_APP_CLIENT_SECRET = "testsecret";
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
  });

  describe("parseOwnerRepo", () => {
    it("parses SSH URL", async () => {
      const mod = await import("../src/lib/githubApp");
      expect(mod.parseOwnerRepo("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL", async () => {
      const mod = await import("../src/lib/githubApp");
      expect(mod.parseOwnerRepo("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    });

    it("parses HTTPS URL without .git suffix", async () => {
      const mod = await import("../src/lib/githubApp");
      expect(mod.parseOwnerRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    });

    it("throws on invalid URL", async () => {
      const mod = await import("../src/lib/githubApp");
      expect(() => mod.parseOwnerRepo("not-a-url")).toThrow();
    });
  });

  describe("buildHttpsCloneUrl", () => {
    it("builds clone URL with token", async () => {
      const mod = await import("../src/lib/githubApp");
      expect(mod.buildHttpsCloneUrl("owner", "repo", "ghs_testtoken")).toBe(
        "https://x-access-token:ghs_testtoken@github.com/owner/repo.git",
      );
    });
  });

  describe("getInstallationToken", () => {
    it("throws when env vars are missing", async () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      const mod = await import("../src/lib/githubApp");
      await expect(mod.getInstallationToken("12345")).rejects.toThrow("GitHub App not configured");
    });

    it("caches token after successful fetch", async () => {
      const mod = await import("../src/lib/githubApp");
      mod.clearAllTokenCaches();

      const fakeToken = "ghs_installation_fake_token";
      let callCount = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
        callCount++;
        return new Response(
          JSON.stringify({ token: fakeToken, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200 },
        );
      });

      const t1 = await mod.getInstallationToken("42");
      expect(t1).toBe(fakeToken);
      expect(callCount).toBe(1);

      const t2 = await mod.getInstallationToken("42");
      expect(t2).toBe(fakeToken);
      expect(callCount).toBe(1);

      vi.restoreAllMocks();
    });

    it("clears cache on clearTokenCache", async () => {
      const mod = await import("../src/lib/githubApp");
      mod.clearAllTokenCaches();

      const fakeToken = "ghs_another_token";
      let callCount = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        callCount++;
        return new Response(
          JSON.stringify({ token: fakeToken, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200 },
        );
      });

      await mod.getInstallationToken("99");
      expect(callCount).toBe(1);

      mod.clearTokenCache("99");

      await mod.getInstallationToken("99");
      expect(callCount).toBe(2);

      vi.restoreAllMocks();
    });

    it("throws on non-ok response", async () => {
      const mod = await import("../src/lib/githubApp");
      mod.clearAllTokenCaches();

      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        return new Response("Unauthorized", { status: 401 });
      });

      await expect(mod.getInstallationToken("42")).rejects.toThrow("GitHub API error");

      vi.restoreAllMocks();
    });
  });

  describe("clearAllTokenCaches", () => {
    it("clears all cached tokens", async () => {
      const mod = await import("../src/lib/githubApp");
      mod.clearAllTokenCaches();

      let callCount = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        callCount++;
        return new Response(
          JSON.stringify({ token: "t1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200 },
        );
      });

      await mod.getInstallationToken("a");
      await mod.getInstallationToken("b");
      expect(callCount).toBe(2);

      mod.clearAllTokenCaches();

      await mod.getInstallationToken("a");
      expect(callCount).toBe(3);

      vi.restoreAllMocks();
    });
  });
});
