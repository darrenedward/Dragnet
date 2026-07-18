import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateMany = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    pullRequest: { updateMany: mockUpdateMany },
    reviewRun: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { completePrReviewIfCurrent, statusForRevision } from "../src/lib/prRevisionStatus";

describe("revision-aware PR status", () => {
  beforeEach(() => mockUpdateMany.mockReset());

  it("moves a completed PR to Pending when its revision changes", () => {
    expect(statusForRevision("Completed", "old", "new")).toBe("Pending");
  });

  it("keeps unchanged completed and non-completed statuses intact", () => {
    expect(statusForRevision("Completed", "same", "same")).toBe("Completed");
    expect(statusForRevision("In Progress", "old", "new")).toBe("In Progress");
    expect(statusForRevision("Failed", "old", "new")).toBe("Failed");
    expect(statusForRevision("Merged", "old", "new")).toBe("Merged");
  });

  it("completes only when the scanned commit is still current", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });

    await expect(completePrReviewIfCurrent("pr-1", "sha-1", 9)).resolves.toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "pr-1", commitHash: "sha-1" },
      data: { status: "Completed", rating: 9 },
    });
  });

  it("leaves a newer revision Pending when an older scan finishes", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await expect(completePrReviewIfCurrent("pr-1", "old", null)).resolves.toBe(false);
    expect(mockUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "pr-1", commitHash: { not: "old" }, status: { notIn: ["Merged", "Failed"] } },
      data: { status: "Pending" },
    });
  });
});
