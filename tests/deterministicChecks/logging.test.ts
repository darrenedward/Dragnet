import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReviewLogCreate = vi.fn();
const mockReviewLogCreateError = vi.fn();

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    reviewLog: {
      create: (...args: unknown[]) => mockReviewLogCreate(...args),
    },
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "test-uuid-12345",
}));

const { logReview } = await import("@/src/services/deterministicChecks/logging");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("logReview", () => {
  it("creates a reviewLog entry with prId and message", async () => {
    mockReviewLogCreate.mockResolvedValue({});

    await logReview("pr-1", "check started");

    expect(mockReviewLogCreate).toHaveBeenCalledWith({
      data: {
        id: "test-uuid-12345",
        prId: "pr-1",
        reviewRunId: null,
        reviewChunkId: null,
        message: "check started",
        level: "info",
      },
    });
  });

  it("defaults level to info", async () => {
    mockReviewLogCreate.mockResolvedValue({});

    await logReview("pr-1", "hello");

    expect(mockReviewLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "info" }),
      }),
    );
  });

  it("accepts custom level", async () => {
    mockReviewLogCreate.mockResolvedValue({});

    await logReview("pr-1", "warning", "warn");

    expect(mockReviewLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "warn" }),
      }),
    );
  });

  it("passes reviewRunId and reviewChunkId when provided", async () => {
    mockReviewLogCreate.mockResolvedValue({});

    await logReview("pr-1", "progress", "info", "run-42", "chunk-7");

    expect(mockReviewLogCreate).toHaveBeenCalledWith({
      data: {
        id: "test-uuid-12345",
        prId: "pr-1",
        reviewRunId: "run-42",
        reviewChunkId: "chunk-7",
        message: "progress",
        level: "info",
      },
    });
  });

  it("does not throw when prisma write fails", async () => {
    mockReviewLogCreate.mockRejectedValue(new Error("DB connection lost"));

    await expect(logReview("pr-1", "should not crash")).resolves.toBeUndefined();
  });
});
