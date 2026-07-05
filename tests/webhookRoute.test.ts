import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

const mocks = vi.hoisted(() => ({
  mockVerifySignature: vi.fn(),
  mockFindRepo: vi.fn(),
  mockGitFetch: vi.fn(),
  mockScanRepoPrs: vi.fn(),
  mockEnqueue: vi.fn(),
  mockCheckDelivery: vi.fn(),
}));

vi.mock("../src/lib/webhook", () => ({
  verifyGithubSignature: mocks.mockVerifySignature,
  findRepoByCloneUrl: mocks.mockFindRepo,
  gitFetch: mocks.mockGitFetch,
  scanRepoPrs: mocks.mockScanRepoPrs,
}));

vi.mock("@/src/services/remoteFetchWorker", () => ({
  enqueue: mocks.mockEnqueue,
}));

vi.mock("../src/lib/webhookReplay", () => ({
  checkDelivery: mocks.mockCheckDelivery,
}));

import { POST } from "../src/app/api/webhooks/github/route";

function sign(payload: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

function buildRequest({
  event = "push",
  delivery = "abc-123",
  signature,
  body,
}: {
  event?: string;
  delivery?: string;
  signature?: string;
  body: Record<string, unknown>;
}) {
  const raw = JSON.stringify(body);
  const sig = signature ?? sign(raw, "test-secret");
  return new Request("https://example.com/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": sig,
      "content-type": "application/json",
    },
    body: raw,
  });
}

describe("webhooks/github/route POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: "/tmp/repo",
      webhookSecret: "test-secret",
    });
    mocks.mockVerifySignature.mockImplementation(
      (payload: string, signature: string, secret: string) => {
        return signature === sign(payload, secret);
      },
    );
    mocks.mockEnqueue.mockResolvedValue(undefined);
    mocks.mockCheckDelivery.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when x-github-event is missing", async () => {
    const req = new Request("https://example.com/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing x-github-event");
  });

  it("returns 401 when x-hub-signature-256 is missing", async () => {
    const req = new Request("https://example.com/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Missing x-hub-signature-256");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://example.com/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=abc",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when repository or clone_url is missing", async () => {
    const req = buildRequest({ body: { notARepo: true } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing/i);
  });

  it("returns 404 when no matching repo found from clone_url", async () => {
    mocks.mockFindRepo.mockResolvedValue(null);
    const req = buildRequest({
      body: { repository: { clone_url: "https://github.com/other/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No matching repository found");
  });

  it("returns 401 when webhook secret is not configured", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: "/tmp/repo",
      webhookSecret: null,
    });
    const req = buildRequest({
      body: { repository: { clone_url: "https://github.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Webhook secret not configured");
  });

  it("returns 401 for invalid HMAC signature", async () => {
    mocks.mockVerifySignature.mockReturnValue(false);
    const req = buildRequest({
      signature: "sha256=invalid",
      body: { repository: { clone_url: "https://github.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid signature");
  });

  it("triggers local scan on valid pull_request event (opened)", async () => {
    const req = buildRequest({
      event: "pull_request",
      body: {
        action: "opened",
        repository: { clone_url: "https://github.com/owner/repo.git" },
        pull_request: { number: 42 },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalledWith("/tmp/repo");
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith("repo-1", "/tmp/repo");
    const body = await res.json();
    expect(body.pr).toBe(42);
  });

  it("triggers local scan on pull_request synchronize event", async () => {
    const req = buildRequest({
      event: "pull_request",
      body: {
        action: "synchronize",
        repository: { clone_url: "https://github.com/owner/repo.git" },
        pull_request: { number: 7 },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalled();
    expect(mocks.mockScanRepoPrs).toHaveBeenCalled();
  });

  it("triggers local scan on pull_request reopened event", async () => {
    const req = buildRequest({
      event: "pull_request",
      body: {
        action: "reopened",
        repository: { clone_url: "https://github.com/owner/repo.git" },
        pull_request: { number: 13 },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalled();
    expect(mocks.mockScanRepoPrs).toHaveBeenCalled();
  });

  it("enqueues remote fetch for pull_request when no localPath", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      webhookSecret: "test-secret",
    });
    const req = buildRequest({
      event: "pull_request",
      body: {
        action: "opened",
        repository: { clone_url: "https://github.com/owner/repo.git" },
        pull_request: { number: 99 },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockEnqueue).toHaveBeenCalledWith("repo-1");
    expect(mocks.mockGitFetch).not.toHaveBeenCalled();
  });

  it("triggers local scan on valid push event", async () => {
    const req = buildRequest({
      event: "push",
      body: {
        repository: { clone_url: "https://github.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalledWith("/tmp/repo");
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith("repo-1", "/tmp/repo");
  });

  it("enqueues remote fetch on push when no localPath", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      webhookSecret: "test-secret",
    });
    const req = buildRequest({
      event: "push",
      body: {
        repository: { clone_url: "https://github.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockEnqueue).toHaveBeenCalledWith("repo-1");
    expect(mocks.mockGitFetch).not.toHaveBeenCalled();
  });

  it("returns ignored for unknown events", async () => {
    const req = buildRequest({
      event: "issues",
      body: {
        repository: { clone_url: "https://github.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toBe(true);
    expect(mocks.mockGitFetch).not.toHaveBeenCalled();
    expect(mocks.mockScanRepoPrs).not.toHaveBeenCalled();
  });

  it("rejects duplicate x-github-delivery (replay protection)", async () => {
    mocks.mockCheckDelivery.mockReturnValue(true);
    const req = buildRequest({
      body: { repository: { clone_url: "https://github.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Duplicate delivery");
  });
});
