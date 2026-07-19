import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repo: { id: "repo-1", hostedMode: true },
  existingPr: null as { id: string } | null,
  autoEnabled: false,
  admitScanJobForPr: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: { findUnique: vi.fn(async () => mocks.repo) },
    pullRequest: {
      findFirst: vi.fn(async () => mocks.existingPr),
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
      update: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    },
  },
}));

vi.mock("@/src/lib/autoRescanPolicy", () => ({
  isAutoRescanEnabledForRepo: vi.fn(async () => mocks.autoEnabled),
}));

vi.mock("@/src/services/scanQueue", () => ({
  admitScanJobForPr: mocks.admitScanJobForPr,
}));

import { triggerHostedScan } from "@/src/services/hostedScan/orchestrator";

const data = {
  prNumber: 7,
  title: "Hosted change",
  headBranch: "feature/hosted",
  baseBranch: "main",
  commitHash: "sha-7",
};

describe("triggerHostedScan automatic policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existingPr = null;
    mocks.autoEnabled = false;
    mocks.admitScanJobForPr.mockResolvedValue({ jobId: "job-7" });
  });

  it("persists a discovered PR but does not admit a job when policy is disabled", async () => {
    const result = await triggerHostedScan("repo-1", data, {
      automatic: true,
      triggerReason: "polling",
    });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.admitScanJobForPr).not.toHaveBeenCalled();
  });

  it("uses the enabled policy and preserves the automatic source reason", async () => {
    mocks.autoEnabled = true;

    const result = await triggerHostedScan("repo-1", data, {
      automatic: true,
      triggerReason: "webhook",
    });

    expect(result).toMatchObject({ ok: true, runId: "job-7" });
    expect(mocks.admitScanJobForPr).toHaveBeenCalledWith({
      prId: expect.any(String),
      triggerReason: "webhook",
    });
  });
});
