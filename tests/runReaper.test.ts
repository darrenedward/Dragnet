import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  prisma: { reviewRun: { updateMany } },
}));

describe("stale run reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMany.mockResolvedValue({ count: 0 });
  });

  it("reaps based on activity heartbeat with legacy fallbacks", async () => {
    const { reapStaleRuns } = await import("../src/services/runReaper");
    await reapStaleRuns();

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "in_progress",
        OR: [
          { lastActivityAt: expect.objectContaining({ lt: expect.any(Date) }) },
          { lastActivityAt: null, lastCheckpointAt: expect.objectContaining({ lt: expect.any(Date) }) },
          { lastActivityAt: null, lastCheckpointAt: null, startedAt: expect.objectContaining({ lt: expect.any(Date) }) },
        ],
      }),
      data: expect.objectContaining({
        status: "failed",
        terminalClass: "infrastructure_failure",
        reliability: "partial",
      }),
    }));
  });
});
