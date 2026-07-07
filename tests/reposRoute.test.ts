import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockAuthenticateSessionOrKey: vi.fn(),
  mockEnforceRepoScope: vi.fn(),
  mockRequireSession: vi.fn(),
  mockHasMasterKey: vi.fn(() => true),
  mockEnqueue: vi.fn(() => Promise.resolve()),
  mockGetProviderFromUrl: vi.fn(() => "github"),
  mockComputeRepoId: vi.fn(() => "repo-id"),
  mockCanonicalizeUrl: vi.fn(() => "https://github.com/owner/repo"),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: {
      findMany: mocks.mockFindMany,
      findFirst: mocks.mockFindFirst,
      findUnique: mocks.mockFindUnique,
      create: mocks.mockCreate,
      update: mocks.mockUpdate,
    },
    apiKey: {
      create: vi.fn(),
      findFirst: vi.fn(() => null),
    },
    oAuthConnection: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.mockAuthenticateSessionOrKey,
  enforceRepoScope: mocks.mockEnforceRepoScope,
  generateApiKey: vi.fn(() => ({ raw: "test-raw", prefix: "test-", hash: "hash" })),
}));

vi.mock("@/src/lib/api-auth", () => ({
  requireSession: mocks.mockRequireSession,
}));

vi.mock("@/src/lib/crypto", () => ({
  encryptSecret: vi.fn(() => ({ cipher: "cipher", iv: "iv", tag: "tag" })),
  hasMasterKey: mocks.mockHasMasterKey,
}));

vi.mock("@/src/services/remoteFetchWorker", () => ({
  enqueue: mocks.mockEnqueue,
}));

vi.mock("@/src/lib/webhookSetup", () => ({
  getProviderFromUrl: mocks.mockGetProviderFromUrl,
}));

vi.mock("@/src/lib/repoIdentity", () => ({
  computeRepoId: mocks.mockComputeRepoId,
  computeLocalRepoId: vi.fn(),
  canonicalizeUrl: mocks.mockCanonicalizeUrl,
}));

import { POST } from "../src/app/api/repos/route";
import { PUT } from "../src/app/api/repos/[id]/route";

function makeReq(body: unknown, method = "POST"): Request {
  return new Request(`http://localhost/api/repos${method === "PUT" ? "/repo-1" : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/repos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: true, user: { id: "u1" } });
    mocks.mockRequireSession.mockRejectedValue(new Error("Session required"));
  });

  it("requires authentication", async () => {
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: false, error: "Unauthorized" });
    const res = await POST(makeReq({ name: "Test" }));
    expect(res.status).toBe(401);
  });

  it("requires a name", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Name is required");
  });

  it("rejects local mode — local branch removed, falls through to cloneUrl validation", async () => {
    const res = await POST(makeReq({ name: "Test", mode: "local" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("cloneUrl is required");
  });

  it("rejects remote mode without cloneUrl", async () => {
    const res = await POST(makeReq({ name: "Test", mode: "ssh", deployKey: "key" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("cloneUrl is required");
  });

  it("accepts SSH mode with deploy key", async () => {
    mocks.mockCreate.mockResolvedValue({ id: "r1" });
    const res = await POST(
      makeReq({ name: "Test", mode: "ssh", cloneUrl: "git@github.com:o/r.git", deployKey: "key" }),
    );
    expect(res.status).toBe(201);
    expect(mocks.mockCreate).toHaveBeenCalled();
  });

  it("accepts PAT mode with token", async () => {
    mocks.mockCreate.mockResolvedValue({ id: "r2" });
    const res = await POST(
      makeReq({ name: "Test", mode: "pat", cloneUrl: "https://github.com/o/r.git", pat: "pat" }),
    );
    expect(res.status).toBe(201);
    expect(mocks.mockCreate).toHaveBeenCalled();
  });

  it("rejects cloneUrl with invalid scheme", async () => {
    const res = await POST(
      makeReq({ name: "Test", mode: "ssh", cloneUrl: "ftp://evil.com/repo", deployKey: "key" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("cloneUrl must be");
  });
});

describe("PUT /api/repos/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: true, user: { id: "u1" } });
    mocks.mockEnforceRepoScope.mockReturnValue(null);
    mocks.mockFindUnique.mockResolvedValue({
      id: "repo-1",
      name: "Test",
      provider: "ssh",
      cloneUrl: "git@github.com:o/r.git",
      cloneUrlHttps: null,
      path: null,
      deployKeyCipher: null,
      deployKeyIv: null,
      deployKeyTag: null,
      patCipher: null,
      patIv: null,
      patTag: null,
      activeBranch: "main",
      status: "idle",
      lastCommitHash: "abc",
      lastCommitMessage: "",
      stabilizationTimer: 0,
      reviewsCount: 0,
      triggerMode: "auto",
      quietPeriodSeconds: 10,
      branchPattern: "*",
      runnerImage: null,
      installCommand: null,
      testCommand: null,
      isPollingEnabled: false,
      skipTier2: false,
      hostedMode: false,
    });
    mocks.mockUpdate.mockResolvedValue({});
  });

  it("requires authentication", async () => {
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: false, error: "Unauthorized" });
    const res = await PUT(makeReq({ name: "Test" }, "PUT"), { params: Promise.resolve({ id: "repo-1" }) });
    expect(res.status).toBe(401);
  });

  it("updates skipTier2 and hostedMode", async () => {
    const res = await PUT(
      makeReq({ skipTier2: true, hostedMode: true }, "PUT"),
      { params: Promise.resolve({ id: "repo-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "repo-1" },
        data: expect.objectContaining({
          skipTier2: true,
          hostedMode: true,
        }),
      }),
    );
  });

  it("does not switch a local repo to remote when mode is not sent", async () => {
    mocks.mockFindUnique.mockResolvedValue({
      id: "repo-1", name: "Test", provider: "local", cloneUrl: null, cloneUrlHttps: null,
      path: "/some/path", deployKeyCipher: null, deployKeyIv: null, deployKeyTag: null,
      patCipher: null, patIv: null, patTag: null, activeBranch: "main", status: "idle",
      lastCommitHash: "abc", lastCommitMessage: "", stabilizationTimer: 0, reviewsCount: 0,
      triggerMode: "auto", quietPeriodSeconds: 10, branchPattern: "*",
      runnerImage: null, installCommand: null, testCommand: null,
      isPollingEnabled: false, skipTier2: false, hostedMode: false,
    });
    const res = await PUT(
      makeReq({ skipTier2: true }, "PUT"),
      { params: Promise.resolve({ id: "repo-1" }) },
    );
    expect(res.status).toBe(200);
    const call = mocks.mockUpdate.mock.calls[0][0];
    expect(call.data.provider).toBeUndefined();
  });
});
