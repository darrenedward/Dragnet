import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

const mocks = vi.hoisted(() => ({
  mockVerifySignature: vi.fn(),
  mockFindRepo: vi.fn(),
  mockGitFetch: vi.fn(),
  mockScanRepoPrs: vi.fn(),
  mockEnqueue: vi.fn(),
  mockCheckDelivery: vi.fn(),
  mockRunPrScan: vi.fn(),
  mockAdmitScanJobForPr: vi.fn((input: { prId: string }) => {
    mocks.mockRunPrScan(input.prId);
    return Promise.resolve({ jobId: `job-${input.prId}`, prId: input.prId, state: "queued", queuePosition: 1 });
  }),
  mockTriggerHostedScan: vi.fn(),
  mockCreateDeliveryLog: vi.fn(),
  mockUpdateDeliveryStatus: vi.fn(),
  mockGetOpenPrIds: vi.fn(),
}));

vi.mock("../src/lib/webhook", () => ({
  verifyGithubSignature: mocks.mockVerifySignature,
  findRepoByCloneUrl: mocks.mockFindRepo,
  gitFetch: mocks.mockGitFetch,
  scanRepoPrs: mocks.mockScanRepoPrs,
  getOpenPrIds: mocks.mockGetOpenPrIds,
}));

vi.mock("@/src/services/remoteFetchWorker", () => ({
  enqueue: mocks.mockEnqueue,
}));

vi.mock("../src/lib/webhookReplay", () => ({
  checkDelivery: mocks.mockCheckDelivery,
}));

vi.mock("@/reviewService", () => ({
  runPrScan: mocks.mockRunPrScan,
}));

vi.mock("@/src/services/scanQueue", () => ({
  admitScanJobForPr: mocks.mockAdmitScanJobForPr,
}));

vi.mock("../src/services/hostedScan/orchestrator", () => ({
  triggerHostedScan: mocks.mockTriggerHostedScan,
}));

vi.mock("../src/lib/webhookDelivery", () => ({
  createDeliveryLog: mocks.mockCreateDeliveryLog,
  updateDeliveryStatus: mocks.mockUpdateDeliveryStatus,
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
      path: "/tmp/repo",
      webhookSecret: "test-secret",
      hostedMode: false,
    });
    mocks.mockVerifySignature.mockImplementation(
      (payload: string, signature: string, secret: string) => {
        return signature === sign(payload, secret);
      },
    );
    mocks.mockEnqueue.mockResolvedValue("/tmp/remote-repo");
    mocks.mockCheckDelivery.mockReturnValue(false);
    mocks.mockScanRepoPrs.mockResolvedValue(["pr-1"]);
    mocks.mockRunPrScan.mockResolvedValue(undefined);
    mocks.mockCreateDeliveryLog.mockResolvedValue("del-1");
    mocks.mockUpdateDeliveryStatus.mockResolvedValue(undefined);
    mocks.mockTriggerHostedScan.mockResolvedValue({ ok: true, prId: "pr-42" });
    mocks.mockGetOpenPrIds.mockResolvedValue(["pr-1"]);
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
      hostedMode: false,
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

  it("triggers AFK scan on valid pull_request event (opened)", async () => {
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
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
    const body = await res.json();
    expect(body.pr).toBe(42);
    expect(body.afkScans).toBe(1);
  });

  it("triggers AFK scan on pull_request synchronize event", async () => {
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
    expect(mocks.mockRunPrScan).toHaveBeenCalled();
  });

  it("triggers AFK scan on pull_request reopened event", async () => {
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
    expect(mocks.mockRunPrScan).toHaveBeenCalled();
  });

  it("enqueues remote fetch for pull_request and triggers AFK scan", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      webhookSecret: "test-secret",
      hostedMode: false,
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
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/remote-repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/remote-repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
    const body = await res.json();
    expect(body.afkScans).toBe(1);
  });

  it("triggers AFK scan on valid push event", async () => {
    const req = buildRequest({
      event: "push",
      body: {
        repository: { clone_url: "https://github.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
  });

  it("enqueues remote fetch on push and triggers AFK scan", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      path: null,
      webhookSecret: "test-secret",
      hostedMode: false,
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
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/remote-repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/remote-repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
    const body = await res.json();
    expect(body.afkScans).toBe(1);
  });

  it("handles enqueue failure gracefully (no AFK scan)", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      path: null,
      webhookSecret: "test-secret",
      hostedMode: false,
    });
    mocks.mockEnqueue.mockRejectedValue(new Error("network error"));
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
    expect(mocks.mockScanRepoPrs).not.toHaveBeenCalled();
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.afkScans).toBe(0);
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
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
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
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
  });

  it("triggers no AFK scan when scanRepoPrs returns empty", async () => {
    mocks.mockScanRepoPrs.mockResolvedValue([]);
    const req = buildRequest({
      event: "push",
      body: {
        repository: { clone_url: "https://github.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalled();
    expect(mocks.mockScanRepoPrs).toHaveBeenCalled();
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.afkScans).toBe(0);
  });

  describe("hosted mode", () => {
    beforeEach(() => {
      mocks.mockFindRepo.mockResolvedValue({
        id: "repo-1",
        localPath: null,
        path: null,
        webhookSecret: "test-secret",
        hostedMode: true,
      });
    });

    it("calls triggerHostedScan for pull_request events on hosted repos", async () => {
      mocks.mockTriggerHostedScan.mockResolvedValue({ ok: true, prId: "pr-hosted-42" });

      const req = buildRequest({
        event: "pull_request",
        body: {
          action: "opened",
          repository: { clone_url: "https://github.com/owner/repo.git" },
          pull_request: {
            number: 42,
            title: "My PR",
            head: { ref: "feature-x", sha: "abc123" },
            base: { ref: "main" },
            user: { login: "octocat" },
            body: "Description here",
          },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hosted).toBe(true);
      expect(body.pr).toBe(42);
      expect(body.prId).toBe("pr-hosted-42");

      expect(mocks.mockTriggerHostedScan).toHaveBeenCalledWith("repo-1", {
        prNumber: 42,
        title: "My PR",
        headBranch: "feature-x",
        baseBranch: "main",
        commitHash: "abc123",
        author: "octocat",
        description: "Description here",
      });

      expect(mocks.mockGitFetch).not.toHaveBeenCalled();
      expect(mocks.mockScanRepoPrs).not.toHaveBeenCalled();
      expect(mocks.mockEnqueue).not.toHaveBeenCalled();
    });

    it("calls triggerHostedScan with defaults for missing pull_request optional fields", async () => {
      const req = buildRequest({
        event: "pull_request",
        body: {
          action: "opened",
          repository: { clone_url: "https://github.com/owner/repo.git" },
          pull_request: {
            number: 7,
            head: { ref: "patch-1", sha: "def456" },
            base: { ref: "main" },
          },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mocks.mockTriggerHostedScan).toHaveBeenCalledWith("repo-1", {
        prNumber: 7,
        title: "Untitled",
        headBranch: "patch-1",
        baseBranch: "main",
        commitHash: "def456",
        author: "webhook",
        description: undefined,
      });
    });

    it("returns 400 when pull_request data is missing head/ref fields", async () => {
      const req = buildRequest({
        event: "pull_request",
        body: {
          action: "opened",
          repository: { clone_url: "https://github.com/owner/repo.git" },
          pull_request: { number: 1 },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 when triggerHostedScan fails", async () => {
      mocks.mockTriggerHostedScan.mockResolvedValue({ ok: false, error: "Scan limit reached" });

      const req = buildRequest({
        event: "pull_request",
        body: {
          action: "synchronize",
          repository: { clone_url: "https://github.com/owner/repo.git" },
          pull_request: {
            number: 99,
            head: { ref: "bugfix", sha: "ghi789" },
            base: { ref: "main" },
          },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Scan limit reached");
    });

    it("scans open PRs for push events on hosted repos", async () => {
      mocks.mockGetOpenPrIds.mockResolvedValue(["pr-open-1", "pr-open-2"]);

      const req = buildRequest({
        event: "push",
        body: {
          repository: { clone_url: "https://github.com/owner/repo.git" },
          ref: "refs/heads/main",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hosted).toBe(true);
      expect(body.afkScans).toBe(2);

      expect(mocks.mockGetOpenPrIds).toHaveBeenCalledWith("repo-1");
      expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-open-1");
      expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-open-2");
      expect(mocks.mockGitFetch).not.toHaveBeenCalled();
      expect(mocks.mockScanRepoPrs).not.toHaveBeenCalled();
    });

    it("returns afkScans 0 for push events when no open PRs exist", async () => {
      mocks.mockGetOpenPrIds.mockResolvedValue([]);

      const req = buildRequest({
        event: "push",
        body: {
          repository: { clone_url: "https://github.com/owner/repo.git" },
          ref: "refs/heads/main",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hosted).toBe(true);
      expect(body.afkScans).toBe(0);
      expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
    });
  });

  describe("delivery logging", () => {
    it("creates a delivery log and updates on successful pull_request", async () => {
      const req = buildRequest({
        event: "pull_request",
        body: {
          action: "opened",
          repository: { clone_url: "https://github.com/owner/repo.git" },
          pull_request: { number: 1 },
        },
      });
      await POST(req);

      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalledWith({
        repoId: "repo-1",
        provider: "github",
        eventType: "pull_request",
        deliveryGuid: "abc-123",
        hostedMode: false,
      });
    });

    it("creates a delivery log for push events", async () => {
      const req = buildRequest({
        event: "push",
        body: {
          repository: { clone_url: "https://github.com/owner/repo.git" },
        },
      });
      await POST(req);

      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalledWith({
        repoId: "repo-1",
        provider: "github",
        eventType: "push",
        deliveryGuid: "abc-123",
        hostedMode: false,
      });
    });

    it("creates a delivery log for ignored events", async () => {
      const req = buildRequest({
        event: "issues",
        body: {
          repository: { clone_url: "https://github.com/owner/repo.git" },
        },
      });
      await POST(req);

      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalled();
      expect(mocks.mockUpdateDeliveryStatus).toHaveBeenCalledWith("del-1", "ignored");
    });
  });
});
