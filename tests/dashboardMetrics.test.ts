import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repositoryCount: vi.fn(),
  reviewRunCount: vi.fn(),
  bugFixEventCount: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    repository: { count: mocks.repositoryCount },
    reviewRun: { count: mocks.reviewRunCount },
    bugFixEvent: { count: mocks.bugFixEventCount },
  },
}));

import { getDashboardMetrics } from "@/src/services/dashboardMetrics";

describe("getDashboardMetrics", () => {
  it("aggregates projects, completed scans, and confirmed fix events", async () => {
    mocks.repositoryCount.mockResolvedValue(24);
    mocks.reviewRunCount.mockResolvedValue(230);
    mocks.bugFixEventCount.mockResolvedValue(87);

    await expect(getDashboardMetrics()).resolves.toEqual({
      projects: 24,
      scans: 230,
      bugsFixed: 87,
    });
    expect(mocks.reviewRunCount).toHaveBeenCalledWith({ where: { status: "completed" } });
  });
});
