import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockAuthenticateSessionOrKey: vi.fn(),
  mockEnforceRepoScope: vi.fn(() => null),
  mockSetupWebhookWithPat: vi.fn(),
  mockDeleteWebhook: vi.fn(),
  mockGetManualWebhookInstructions: vi.fn(() => "instructions"),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: {
      findUnique: mocks.mockFindUnique,
      update: mocks.mockUpdate,
    },
  },
}));

vi.mock("@/src/lib/apiAuth", () => ({
  authenticateSessionOrKey: mocks.mockAuthenticateSessionOrKey,
  enforceRepoScope: mocks.mockEnforceRepoScope,
}));

vi.mock("@/src/lib/webhookSetup", () => ({
  setupWebhookWithPat: mocks.mockSetupWebhookWithPat,
  deleteWebhook: mocks.mockDeleteWebhook,
  getManualWebhookInstructions: mocks.mockGetManualWebhookInstructions,
}));

import { POST, DELETE } from "../src/app/api/repos/[id]/webhook/route";

function makeReq(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/repos/repo-1/webhook", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const params = Promise.resolve({ id: "repo-1" });

describe("POST /api/repos/[id]/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: true, user: { id: "u1" } });
    mocks.mockFindUnique.mockResolvedValue({
      id: "repo-1",
      patCipher: "c",
      webhookSecret: "sec",
    });
    mocks.mockUpdate.mockResolvedValue({});
  });

  it("manual webhookId register enables processing", async () => {
    const res = await POST(makeReq("POST", { webhookId: "manual-99" }), { params });
    expect(res.status).toBe(200);
    expect(mocks.mockUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { webhookId: "manual-99", webhookEnabled: true },
    });
    const body = await res.json();
    expect(body).toEqual({ success: true, webhookId: "manual-99" });
  });

  it("PAT setup delegates to setupWebhookWithPat (which enables processing)", async () => {
    mocks.mockSetupWebhookWithPat.mockResolvedValue({ webhookId: "auto-1" });
    const res = await POST(makeReq("POST", {}), { params });
    expect(res.status).toBe(200);
    expect(mocks.mockSetupWebhookWithPat).toHaveBeenCalledWith("repo-1", { targetUrl: undefined });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.webhookId).toBe("auto-1");
  });
});

describe("DELETE /api/repos/[id]/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockAuthenticateSessionOrKey.mockResolvedValue({ ok: true, user: { id: "u1" } });
    mocks.mockDeleteWebhook.mockResolvedValue(undefined);
  });

  it("delegates to deleteWebhook (clears id and disables processing)", async () => {
    const res = await DELETE(makeReq("DELETE"), { params });
    expect(res.status).toBe(200);
    expect(mocks.mockDeleteWebhook).toHaveBeenCalledWith("repo-1");
  });
});
