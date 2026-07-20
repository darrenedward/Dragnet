import { describe, it, expect, vi, beforeEach } from "vitest";

const txBugFixEventCreate = vi.fn();
const reviewRunFindFirst = vi.fn();
const reviewRunFindUnique = vi.fn();
const reviewFindingFindMany = vi.fn();
const transactionCallback = vi.fn();

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    $transaction: (cbOrArray: any) => {
      if (typeof cbOrArray === "function") {
        transactionCallback(cbOrArray);
        return cbOrArray({ bugFixEvent: { create: txBugFixEventCreate } });
      }
      return Promise.all(cbOrArray);
    },
    reviewRun: {
      findUnique: reviewRunFindUnique,
      findFirst: reviewRunFindFirst,
    },
    reviewFinding: {
      findMany: reviewFindingFindMany,
    },
    bugFixEvent: {
      create: txBugFixEventCreate,
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
        { id: "f1", filename: "a.ts", line: 1, category: "security", severity: "blocker" },
        { id: "f2", filename: "b.ts", line: 5, category: "performance", severity: "blocker" },
        { id: "f3", filename: "b.ts", line: 5, category: "performance", severity: "blocker" },
      ]);

    txBugFixEventCreate
      .mockResolvedValueOnce({ id: "evt-1" })
      .mockRejectedValueOnce(Object.assign(new Error("Unique constraint"), { code: "P2002" }));

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    const result = await recordFixesForCompletedScan("run-2");
    expect(result).toEqual({ written: 1, skipped: 1 });
  });

  it("rethrows non-P2002 errors from bugFixEvent.create", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-2",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });

    reviewRunFindFirst.mockResolvedValue({ id: "run-1" });

    reviewFindingFindMany
      .mockResolvedValueOnce([{ filename: "a.ts", line: 1, category: "security", severity: "blocker" }])
      .mockResolvedValueOnce([{ id: "f1", filename: "a.ts", line: 1, category: "security", severity: "blocker" }, { id: "f2", filename: "b.ts", line: 5, category: "performance", severity: "blocker" }]);

    txBugFixEventCreate.mockRejectedValueOnce(new Error("DB connection lost"));

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    await expect(recordFixesForCompletedScan("run-2")).rejects.toThrow("DB connection lost");
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

  it("idempotent on re-run — second call returns written:0, skipped:1", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-2",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });

    reviewRunFindFirst.mockResolvedValue({ id: "run-1" });

    reviewFindingFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "f1", filename: "a.ts", line: 1, category: "security", severity: "blocker" }]);

    txBugFixEventCreate.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint"), { code: "P2002" }),
    );

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    const result = await recordFixesForCompletedScan("run-2");
    expect(result).toEqual({ written: 0, skipped: 1 });
  });

  it("records resolved warnings and suggestions, not only blockers", async () => {
    reviewRunFindUnique.mockResolvedValue({
      id: "run-2",
      prId: "pr-1",
      status: "completed",
      outcome: "reviewed",
    });
    reviewRunFindFirst.mockResolvedValue({ id: "run-1" });
    reviewFindingFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "f1", filename: "a.ts", line: 1, category: "style", severity: "warning" },
        { id: "f2", filename: "b.ts", line: 2, category: "quality", severity: "suggestion" },
      ]);
    txBugFixEventCreate.mockResolvedValue({ id: "evt" });

    const { recordFixesForCompletedScan } = await import(
      "../src/services/findingLifecycle/bugFixTracker"
    );

    expect(await recordFixesForCompletedScan("run-2")).toEqual({ written: 2, skipped: 0 });
    expect(txBugFixEventCreate).toHaveBeenCalledTimes(2);
  });
});
