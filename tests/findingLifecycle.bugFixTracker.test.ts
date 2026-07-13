import { describe, it, expect, vi, beforeEach } from "vitest";

const bugFixEventCreate = vi.fn();
const reviewRunFindFirst = vi.fn();
const reviewRunFindUnique = vi.fn();
const reviewFindingFindMany = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    reviewRun: {
      findUnique: reviewRunFindUnique,
      findFirst: reviewRunFindFirst,
    },
    reviewFinding: {
      findMany: reviewFindingFindMany,
    },
    bugFixEvent: {
      create: bugFixEventCreate,
    },
  },
}));

describe("recordFixesForCompletedScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns written:1, skipped:1 when P2002 fires on the second BugFixEvent", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-2",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });

    reviewRunFindFirst.mockResolvedValue({
      id: "run-1",
    });

    reviewFindingFindMany
      .mockResolvedValueOnce([
        { filename: "a.ts", line: 1, category: "security", severity: "blocker" },
      ])
      .mockResolvedValueOnce([
        { filename: "a.ts", line: 1, category: "security", severity: "blocker" },
        { filename: "b.ts", line: 5, category: "performance", severity: "blocker" },
        { filename: "b.ts", line: 5, category: "performance", severity: "blocker" },
      ]);

    bugFixEventCreate
      .mockResolvedValueOnce({ id: "evt-1" })
      .mockRejectedValueOnce(Object.assign(new Error("Unique constraint"), { code: "P2002" }));

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    const result = await recordFixesForCompletedScan("run-2");
    expect(result).toEqual({ written: 1, skipped: 1 });
  });

  it("handles non-P2002 errors from bugFixEvent.create by logging and NOT writing", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-2",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });

    reviewRunFindFirst.mockResolvedValue({ id: "run-1" });

    reviewFindingFindMany
      .mockResolvedValueOnce([{ filename: "a.ts", line: 1, category: "security", severity: "blocker" }])
      .mockResolvedValueOnce([{ filename: "a.ts", line: 1, category: "security", severity: "blocker" }, { filename: "b.ts", line: 5, category: "performance", severity: "blocker" }]);

    bugFixEventCreate.mockRejectedValueOnce(new Error("DB connection lost"));

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    const result = await recordFixesForCompletedScan("run-2");
    expect(result).toEqual({ written: 0, skipped: 0 });
  });

  it("returns zeros when no prior run exists", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-1",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });

    reviewRunFindFirst.mockResolvedValue(null);

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    expect(await recordFixesForCompletedScan("run-1")).toEqual({ written: 0, skipped: 0 });
  });

  it("returns zeros when run status is not completed", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-1",
      prId: "pr-1",
      status: "in_progress",
      outcome: null,
    });

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    expect(await recordFixesForCompletedScan("run-1")).toEqual({ written: 0, skipped: 0 });
  });

  it("returns zeros when run outcome is skipped", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-1",
      prId: "pr-1",
      status: "completed",
      outcome: "skipped",
    });

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    expect(await recordFixesForCompletedScan("run-1")).toEqual({ written: 0, skipped: 0 });
  });
});
