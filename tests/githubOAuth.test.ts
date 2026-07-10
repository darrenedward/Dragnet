import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock hoisted functions
const mockRequireSession = vi.hoisted(() => vi.fn());
const mockStoreCsrfToken = vi.hoisted(() => vi.fn());
const mockConsumeCsrfToken = vi.hoisted(() => vi.fn());
const mockOAuthConnectionUpsert = vi.hoisted(() => vi.fn());
const mockOAuthConnectionFindUnique = vi.hoisted(() => vi.fn());
const mockOAuthConnectionDelete = vi.hoisted(() => vi.fn());
const mockRepositoryUpdateMany = vi.hoisted(() => vi.fn());
const mockHasMasterKey = vi.hoisted(() => vi.fn());
const mockEncryptSecret = vi.hoisted(() => vi.fn());
const mockClearTokenCache = vi.hoisted(() => vi.fn());

// Mock the modules
vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mockRequireSession,
}));

vi.mock("@/src/lib/oauthState", () => ({
  storeCsrfToken: mockStoreCsrfToken,
  consumeCsrfToken: mockConsumeCsrfToken,
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    oAuthConnection: {
      upsert: mockOAuthConnectionUpsert,
      findUnique: mockOAuthConnectionFindUnique,
      delete: mockOAuthConnectionDelete,
    },
    repository: {
      updateMany: mockRepositoryUpdateMany,
    },
  },
}));

vi.mock("@/src/lib/crypto", () => ({
  hasMasterKey: mockHasMasterKey,
  encryptSecret: mockEncryptSecret,
}));

vi.mock("@/src/lib/githubApp", () => ({
  clearTokenCache: mockClearTokenCache,
}));

describe("GitHub OAuth Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default session mock
    mockRequireSession.mockResolvedValue({
      user: { id: "user-123", email: "test@example.com" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/github/oauth/start", () => {
    it("redirects with 401 error when not authenticated", async () => {
      mockRequireSession.mockRejectedValue(new Error("Unauthorized"));

      const { GET } = await import("@/src/app/api/github/oauth/start/route");
      const req = new Request("http://localhost/api/github/oauth/start");
      const res = await GET(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 500 when GITHUB_APP_CLIENT_ID is not set", async () => {
      delete process.env.GITHUB_APP_CLIENT_ID;

      const { GET } = await import("@/src/app/api/github/oauth/start/route");
      const req = new Request("http://localhost/api/github/oauth/start");
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("GITHUB_APP_CLIENT_ID");
    });

    // Note: start route only validates GITHUB_APP_CLIENT_ID, not CLIENT_SECRET
    // CLIENT_SECRET validation happens in the callback route instead

    it("redirects to GitHub with correct params on success", async () => {
      process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
      process.env.APP_URL = "http://localhost:3300";

      const { GET } = await import("@/src/app/api/github/oauth/start/route");
      const req = new Request("http://localhost/api/github/oauth/start");
      const res = await GET(req);

      expect(res.status).toBe(307); // NextResponse.redirect uses 307
      expect(res.headers.get("location")).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
      const location = res.headers.get("location")!;
      expect(location).toContain("client_id=test-client-id");
      expect(location).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3300%2Fapi%2Fgithub%2Foauth%2Fcallback");
      expect(location).toContain("scope=repo%2Cread%3Aorg%2Cadmin%3Arepo_hooks");
      expect(location).toContain("state=");

      expect(mockStoreCsrfToken).toHaveBeenCalledWith("user-123", expect.any(String));
    });
  });

  describe("GET /api/github/oauth/callback", () => {
    beforeEach(() => {
      process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
      process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
      process.env.APP_URL = "http://localhost:3300";
      process.env.GITHUB_APP_PRIVATE_KEY = "test-private-key";
      mockConsumeCsrfToken.mockReturnValue(true);
      mockHasMasterKey.mockReturnValue(true);
      mockEncryptSecret.mockReturnValue({
        cipher: "encrypted",
        iv: "iv",
        tag: "tag",
      });
    });

    it("redirects with error when error query param is present", async () => {
      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?error=access_denied");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=access_denied");
    });

    it("redirects with missing_params error when code is missing", async () => {
      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=missing_params");
    });

    it("redirects with missing_params error when state is missing", async () => {
      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=missing_params");
    });

    it("returns 500 when GITHUB_APP_CLIENT_ID is not set", async () => {
      delete process.env.GITHUB_APP_CLIENT_ID;

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("GitHub App not configured");
    });

    it("returns 500 when GITHUB_APP_CLIENT_SECRET is not set", async () => {
      process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
      delete process.env.GITHUB_APP_CLIENT_SECRET;

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("GitHub App not configured");
    });

    it("redirects with no_session error when not authenticated", async () => {
      mockRequireSession.mockRejectedValue(new Error("Unauthorized"));

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=no_session");
    });

    it("redirects with invalid_state error when CSRF token is invalid", async () => {
      mockConsumeCsrfToken.mockReturnValue(false);

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=invalid_state");
    });

    it("redirects with token_exchange_failed error when GitHub token exchange fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Bad Request",
      });

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=token_exchange_failed");
    });

    it("redirects with GitHub error when token response contains error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: "invalid_grant", error_description: "The code has expired" }),
      });

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=The%20code%20has%20expired");
    });

    it("redirects with installations_fetch_failed error when installations fetch fails", async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "test-token", token_type: "bearer" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => "Unauthorized",
        });

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=installations_fetch_failed");
    });

    it("redirects with no_installations error when installations array is empty", async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "test-token", token_type: "bearer" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ installations: [] }),
        });

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=error");
      expect(location).toContain("reason=no_installations");
    });

    it("succeeds with installation_id and repos when all calls succeed", async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "test-token", token_type: "bearer" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ installations: [{ id: 12345 }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            repositories: [
              { id: 1, full_name: "owner/repo1" },
              { id: 2, full_name: "owner/repo2" },
            ],
          }),
        });

      mockOAuthConnectionUpsert.mockResolvedValue({});

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=success");
      expect(location).toContain("installation_id=12345");
      expect(location).toContain("repos=");

      const url = new URL(location);
      const reposParam = url.searchParams.get("repos");
      expect(reposParam).toBeTruthy();
      // The callback route does encodeURIComponent(JSON.stringify(repos)), so we need decodeURIComponent
      const repos = JSON.parse(decodeURIComponent(reposParam!));
      expect(repos).toEqual([
        { id: 1, fullName: "owner/repo1" },
        { id: 2, fullName: "owner/repo2" },
      ]);

      expect(mockOAuthConnectionUpsert).toHaveBeenCalledWith({
        where: {
          userId_provider: { userId: "user-123", provider: "github" },
        },
        create: {
          userId: "user-123",
          provider: "github",
          installationId: "12345",
          appPrivateKeyCipher: "encrypted",
          appPrivateKeyIv: "iv",
          appPrivateKeyTag: "tag",
          accessTokenCipher: "encrypted",
          accessTokenIv: "iv",
          accessTokenTag: "tag",
        },
        update: {
          installationId: "12345",
          appPrivateKeyCipher: "encrypted",
          appPrivateKeyIv: "iv",
          appPrivateKeyTag: "tag",
          accessTokenCipher: "encrypted",
          accessTokenIv: "iv",
          accessTokenTag: "tag",
        },
      });
    });

    it("handles empty repos gracefully when repos fetch fails", async () => {
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "test-token", token_type: "bearer" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ installations: [{ id: 12345 }] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ repositories: [] }),
        });

      mockOAuthConnectionUpsert.mockResolvedValue({});

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location")!;
      expect(location).toContain("github_oauth=success");

      const url = new URL(location);
      const reposParam = url.searchParams.get("repos");
      expect(reposParam).toBeTruthy();
      // The callback route does encodeURIComponent(JSON.stringify(repos)), so we need decodeURIComponent
      const repos = JSON.parse(decodeURIComponent(reposParam!));
      expect(repos).toEqual([]);
    });

    it("does not encrypt when hasMasterKey returns false", async () => {
      mockHasMasterKey.mockReturnValue(false);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ access_token: "test-token", token_type: "bearer" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ installations: [{ id: 12345 }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ repositories: [] }),
        });

      mockOAuthConnectionUpsert.mockResolvedValue({});

      const { GET } = await import("@/src/app/api/github/oauth/callback/route");
      const req = new Request("http://localhost/api/github/oauth/callback?code=test-code&state=test-state");
      const res = await GET(req);

      expect(res.status).toBe(307);

      expect(mockOAuthConnectionUpsert).toHaveBeenCalledWith({
        where: {
          userId_provider: { userId: "user-123", provider: "github" },
        },
        create: {
          userId: "user-123",
          provider: "github",
          installationId: "12345",
          appPrivateKeyCipher: undefined,
          appPrivateKeyIv: undefined,
          appPrivateKeyTag: undefined,
          accessTokenCipher: undefined,
          accessTokenIv: undefined,
          accessTokenTag: undefined,
        },
        update: {
          installationId: "12345",
          appPrivateKeyCipher: undefined,
          appPrivateKeyIv: undefined,
          appPrivateKeyTag: undefined,
          accessTokenCipher: undefined,
          accessTokenIv: undefined,
          accessTokenTag: undefined,
        },
      });
    });
  });

  describe("POST /api/github/oauth/disconnect", () => {
    beforeEach(() => {
      process.env.APP_URL = "http://localhost:3300";
    });

    it("returns 401 when not authenticated", async () => {
      mockRequireSession.mockRejectedValue(new Error("Unauthorized"));

      const { POST } = await import("@/src/app/api/github/oauth/disconnect/route");
      const req = new Request("http://localhost/api/github/oauth/disconnect", { method: "POST" });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns 404 when no connection exists", async () => {
      mockOAuthConnectionFindUnique.mockResolvedValue(null);

      const { POST } = await import("@/src/app/api/github/oauth/disconnect/route");
      const req = new Request("http://localhost/api/github/oauth/disconnect", { method: "POST" });
      const res = await POST(req);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("No GitHub connection found.");
    });

    it("deletes connection and clears token cache on success", async () => {
      const mockConnection = {
        id: "conn-123",
        userId: "user-123",
        provider: "github",
        installationId: "12345",
      };
      mockOAuthConnectionFindUnique.mockResolvedValue(mockConnection);
      mockOAuthConnectionDelete.mockResolvedValue(mockConnection);
      mockRepositoryUpdateMany.mockResolvedValue({ count: 1 });

      const { POST } = await import("@/src/app/api/github/oauth/disconnect/route");
      const req = new Request("http://localhost/api/github/oauth/disconnect", { method: "POST" });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      expect(mockClearTokenCache).toHaveBeenCalledWith("12345");
      expect(mockOAuthConnectionDelete).toHaveBeenCalledWith({
        where: { id: "conn-123" },
      });
      expect(mockRepositoryUpdateMany).toHaveBeenCalledWith({
        where: { installationId: "12345" },
        data: { installationId: null },
      });
    });
  });

  describe("GET /api/github/connection", () => {
    beforeEach(() => {
      process.env.APP_URL = "http://localhost:3300";
    });

    it("returns 401 when not authenticated", async () => {
      mockRequireSession.mockRejectedValue(new Error("Unauthorized"));

      const { GET } = await import("@/src/app/api/github/connection/route");
      const req = new Request("http://localhost/api/github/connection");
      const res = await GET(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("returns connected: false when no connection exists", async () => {
      mockOAuthConnectionFindUnique.mockResolvedValue(null);

      const { GET } = await import("@/src/app/api/github/connection/route");
      const req = new Request("http://localhost/api/github/connection");
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.connected).toBe(false);
    });

    it("returns connected: true with installationId when connection exists", async () => {
      const mockConnection = {
        id: "conn-123",
        userId: "user-123",
        provider: "github",
        installationId: "12345",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      };
      mockOAuthConnectionFindUnique.mockResolvedValue(mockConnection);

      const { GET } = await import("@/src/app/api/github/connection/route");
      const req = new Request("http://localhost/api/github/connection");
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.connected).toBe(true);
      expect(body.installationId).toBe("12345");
      expect(body.createdAt).toBe("2024-01-01T00:00:00.000Z");
    });
  });
});
