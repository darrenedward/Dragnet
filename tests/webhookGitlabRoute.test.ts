import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockVerifyGitlabToken: vi.fn(),
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
  verifyGitlabToken: mocks.mockVerifyGitlabToken,
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

import { POST } from "../src/app/api/webhooks/gitlab/route";

function buildRequest({
  event = "Push Hook",
  delivery = "uuid-123",
  token = "test-secret",
  body,
}: {
  event?: string;
  delivery?: string;
  token?: string;
  body: Record<string, unknown>;
}) {
  const raw = JSON.stringify(body);
  return new Request("https://example.com/api/webhooks/gitlab", {
    method: "POST",
    headers: {
      "x-gitlab-event": event,
      "x-gitlab-event-uuid": delivery,
      "x-gitlab-token": token,
      "content-type": "application/json",
    },
    body: raw,
  });
}

describe("webhooks/gitlab/route POST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: "/tmp/repo",
      path: "/tmp/repo",
      webhookSecret: "test-secret",
      hostedMode: false,
    });
    mocks.mockVerifyGitlabToken.mockImplementation(
      (token: string, secret: string) => token === secret,
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

  it("returns 400 when x-gitlab-event is missing", async () => {
    const req = new Request("https://example.com/api/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing x-gitlab-event");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://example.com/api/webhooks/gitlab", {
      method: "POST",
      headers: {
        "x-gitlab-event": "Push Hook",
        "x-gitlab-token": "test",
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when project is missing", async () => {
    const req = buildRequest({ body: { notAProject: true } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing/i);
  });

  it("returns 400 when clone url is missing", async () => {
    const req = buildRequest({ body: { project: { name: "test" } } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("clone URL");
  });

  it("returns 404 when no matching repo found", async () => {
    mocks.mockFindRepo.mockResolvedValue(null);
    const req = buildRequest({
      body: {
        project: { git_http_url: "https://gitlab.com/other/repo.git" },
      },
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
      path: "/tmp/repo",
      webhookSecret: null,
      hostedMode: false,
    });
    const req = buildRequest({
      body: { project: { git_http_url: "https://gitlab.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Webhook secret not configured");
  });

  it("returns 401 for invalid token", async () => {
    mocks.mockVerifyGitlabToken.mockReturnValue(false);
    const req = buildRequest({
      token: "wrong-secret",
      body: { project: { git_http_url: "https://gitlab.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid token");
  });

  it("rejects duplicate delivery UUID (replay protection)", async () => {
    mocks.mockCheckDelivery.mockReturnValue(true);
    const req = buildRequest({
      body: { project: { git_http_url: "https://gitlab.com/owner/repo.git" } },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Duplicate delivery");
  });

  it("triggers AFK scan on Merge Request Hook event", async () => {
    const req = buildRequest({
      event: "Merge Request Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
        object_attributes: { iid: 42, title: "MR title" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
    const body = await res.json();
    expect(body.mr).toBe(42);
    expect(body.afkScans).toBe(1);
  });

  it("returns 400 for Merge Request Hook with missing object_attributes", async () => {
    const req = buildRequest({
      event: "Merge Request Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("triggers AFK scan on Push Hook event", async () => {
    const req = buildRequest({
      event: "Push Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
        ref: "refs/heads/main",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockScanRepoPrs).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/repo" }));
    expect(mocks.mockRunPrScan).toHaveBeenCalledWith("pr-1");
  });

  it("enqueues remote fetch when localPath is null", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      path: null,
      webhookSecret: "test-secret",
      hostedMode: false,
    });
    const req = buildRequest({
      event: "Push Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockEnqueue).toHaveBeenCalledWith("repo-1");
    expect(mocks.mockGitFetch).toHaveBeenCalledWith(expect.objectContaining({ id: "repo-1", path: "/tmp/remote-repo" }));
  });

  it("handles enqueue failure gracefully", async () => {
    mocks.mockFindRepo.mockResolvedValue({
      id: "repo-1",
      localPath: null,
      path: null,
      webhookSecret: "test-secret",
      hostedMode: false,
    });
    mocks.mockEnqueue.mockRejectedValue(new Error("network error"));
    const req = buildRequest({
      event: "Push Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).not.toHaveBeenCalled();
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
  });

  it("returns ignored for unknown events", async () => {
    const req = buildRequest({
      event: "Pipeline Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toBe(true);
    expect(mocks.mockRunPrScan).not.toHaveBeenCalled();
  });

  it("triggers no AFK scan when scanRepoPrs returns empty", async () => {
    mocks.mockScanRepoPrs.mockResolvedValue([]);
    const req = buildRequest({
      event: "Push Hook",
      body: {
        project: { git_http_url: "https://gitlab.com/owner/repo.git" },
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mocks.mockGitFetch).toHaveBeenCalled();
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

    it("calls triggerHostedScan for Merge Request Hook events", async () => {
      mocks.mockTriggerHostedScan.mockResolvedValue({ ok: true, prId: "pr-hosted-1" });

      const req = buildRequest({
        event: "Merge Request Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
          object_attributes: {
            iid: 42,
            title: "Fix the bug",
            source_branch: "fix/bug",
            target_branch: "main",
            last_commit: { id: "abc123" },
            author_id: 5,
            description: "Fixes the critical bug",
          },
          user: { name: "gitlab_user" },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hosted).toBe(true);
      expect(body.mr).toBe(42);

      expect(mocks.mockTriggerHostedScan).toHaveBeenCalledWith("repo-1", {
        prNumber: 42,
        title: "Fix the bug",
        headBranch: "fix/bug",
        baseBranch: "main",
        commitHash: "abc123",
        author: "gitlab_user",
        description: "Fixes the critical bug",
      });
      expect(mocks.mockGitFetch).not.toHaveBeenCalled();
      expect(mocks.mockEnqueue).not.toHaveBeenCalled();
    });

    it("calls triggerHostedScan with defaults for missing optional fields", async () => {
      const req = buildRequest({
        event: "Merge Request Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
          object_attributes: {
            iid: 7,
            title: "Simple fix",
            source_branch: "patch-1",
            target_branch: "main",
            last_commit: { id: "def456" },
          },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mocks.mockTriggerHostedScan).toHaveBeenCalledWith("repo-1", {
        prNumber: 7,
        title: "Simple fix",
        headBranch: "patch-1",
        baseBranch: "main",
        commitHash: "def456",
        author: "webhook",
        description: undefined,
      });
    });

    it("returns 400 when object_attributes is missing head fields", async () => {
      const req = buildRequest({
        event: "Merge Request Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
          object_attributes: { iid: 1 },
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("scans open PRs for Push Hook events on hosted repos", async () => {
      mocks.mockGetOpenPrIds.mockResolvedValue(["pr-open-1", "pr-open-2"]);

      const req = buildRequest({
        event: "Push Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
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
    });

    it("returns afkScans 0 for Push Hook when no open PRs exist", async () => {
      mocks.mockGetOpenPrIds.mockResolvedValue([]);

      const req = buildRequest({
        event: "Push Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
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
    it("creates a delivery log for Merge Request Hook", async () => {
      const req = buildRequest({
        event: "Merge Request Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
          object_attributes: { iid: 1 },
        },
      });
      await POST(req);
      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalledWith({
        repoId: "repo-1",
        provider: "gitlab",
        eventType: "Merge Request Hook",
        deliveryGuid: "uuid-123",
        hostedMode: false,
      });
    });

    it("creates a delivery log for Push Hook", async () => {
      const req = buildRequest({
        event: "Push Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
        },
      });
      await POST(req);
      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalledWith({
        repoId: "repo-1",
        provider: "gitlab",
        eventType: "Push Hook",
        deliveryGuid: "uuid-123",
        hostedMode: false,
      });
    });

    it("updates delivery to ignored for unknown events", async () => {
      const req = buildRequest({
        event: "Note Hook",
        body: {
          project: { git_http_url: "https://gitlab.com/owner/repo.git" },
        },
      });
      await POST(req);
      expect(mocks.mockCreateDeliveryLog).toHaveBeenCalled();
      expect(mocks.mockUpdateDeliveryStatus).toHaveBeenCalledWith("del-1", "ignored");
    });
  });
});
