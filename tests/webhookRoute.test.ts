import { describe, it, expect, beforeEach, vi } from "vitest";

const mockVerifyGithubSignature = vi.hoisted(() => vi.fn());
const mockFindRepoByCloneUrl = vi.hoisted(() => vi.fn());
const mockVerifyReplayAttack = vi.hoisted(() => vi.fn());
const mockGitFetch = vi.hoisted(() => vi.fn());
const mockScanRepoPrs = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());
const mockPrismaUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: {
      update: mockPrismaUpdate,
    },
  },
}));

vi.mock("@/src/lib/webhook", () => ({
  verifyGithubSignature: mockVerifyGithubSignature,
  findRepoByCloneUrl: mockFindRepoByCloneUrl,
  verifyReplayAttack: mockVerifyReplayAttack,
  gitFetch: mockGitFetch,
  scanRepoPrs: mockScanRepoPrs,
}));

vi.mock("@/src/services/remoteFetchWorker", () => ({
  enqueue: mockEnqueue,
}));

async function postToWebhook(headers: Record<string, string>, body: unknown): Promise<Response> {
  const { POST } = await import("@/src/app/api/webhooks/github/route");
  const req = new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: JSON.stringify(body),
  });
  return POST(req);
}

describe("github webhook route", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockVerifyGithubSignature.mockReturnValue(true);
    mockFindRepoByCloneUrl.mockResolvedValue({
      id: "repo-1",
      localPath: "/tmp/repo",
      webhookSecret: "s3cret",
      webhookEnabled: true,
    });
    mockVerifyReplayAttack.mockReturnValue(true);
    mockGitFetch.mockReturnValue(true);
    mockScanRepoPrs.mockResolvedValue(undefined);
    mockEnqueue.mockResolvedValue(undefined);
    mockPrismaUpdate.mockResolvedValue({});
  });

  it("returns 400 when x-github-delivery is missing", async () => {
    const res = await postToWebhook(
      { "x-github-event": "push", "x-hub-signature-256": "sha256=abc" },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("x-github-delivery");
  });

  it("returns 400 when x-github-event is missing", async () => {
    const res = await postToWebhook(
      { "x-github-delivery": "guid-1", "x-hub-signature-256": "sha256=abc" },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("x-github-event");
  });

  it("returns 401 when x-hub-signature-256 is missing", async () => {
    const res = await postToWebhook(
      { "x-github-delivery": "guid-1", "x-github-event": "push" },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("x-hub-signature-256");
  });

  it("returns 429 when replay attack detected", async () => {
    mockVerifyReplayAttack.mockReturnValue(false);
    const res = await postToWebhook(
      {
        "x-github-delivery": "replayed-guid",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=abc",
      },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toContain("Replay");
  });

  it("returns 404 when no matching repository found", async () => {
    mockFindRepoByCloneUrl.mockResolvedValue(null);
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-2",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=abc",
      },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/unknown/repo.git" } },
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when webhook is disabled", async () => {
    mockFindRepoByCloneUrl.mockResolvedValue({
      id: "repo-1",
      localPath: "/tmp/repo",
      webhookSecret: "s3cret",
      webhookEnabled: false,
    });
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-3",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=abc",
      },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when signature is invalid", async () => {
    mockVerifyGithubSignature.mockReturnValue(false);
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-4",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=bad",
      },
      { ref: "refs/heads/main", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("signature");
  });

  it("triggers scan for valid pull_request event", async () => {
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-5",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=abc",
      },
      {
        action: "opened",
        pull_request: { number: 42 },
        repository: { clone_url: "https://github.com/user/repo.git" },
      },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.pr).toBe(42);
    expect(mockScanRepoPrs).toHaveBeenCalledWith("repo-1", "/tmp/repo");
  });

  it("triggers scoped scan for valid push event with branch", async () => {
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-6",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=abc",
      },
      { ref: "refs/heads/feature/my-feature", repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.branch).toBe("feature/my-feature");
    expect(mockScanRepoPrs).toHaveBeenCalledWith("repo-1", "/tmp/repo", "feature/my-feature");
  });

  it("returns ok true for ignored events", async () => {
    const res = await postToWebhook(
      {
        "x-github-delivery": "guid-7",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=abc",
      },
      { repository: { clone_url: "https://github.com/user/repo.git" } },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ignored).toBe(true);
  });
});
