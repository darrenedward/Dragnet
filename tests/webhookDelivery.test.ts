import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockPrismaCreate: vi.fn(),
  mockPrismaUpdate: vi.fn(),
}));

vi.mock("../src/lib/prisma", () => ({
  prisma: {
    webhookDelivery: {
      create: mocks.mockPrismaCreate,
      update: mocks.mockPrismaUpdate,
    },
  },
}));

import { createDeliveryLog, updateDeliveryStatus } from "../src/lib/webhookDelivery";

describe("createDeliveryLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a delivery log with received status", async () => {
    mocks.mockPrismaCreate.mockResolvedValue({ id: "del-1" });

    const id = await createDeliveryLog({
      repoId: "repo-1",
      provider: "github",
      eventType: "pull_request",
      deliveryGuid: "abc-123",
      hostedMode: false,
    });

    expect(mocks.mockPrismaCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repoId: "repo-1",
        provider: "github",
        eventType: "pull_request",
        deliveryGuid: "abc-123",
        status: "received",
        hostedMode: false,
      }),
    });
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(0);
  });

  it("accepts optional prNumber", async () => {
    mocks.mockPrismaCreate.mockResolvedValue({ id: "del-2" });

    await createDeliveryLog({
      repoId: "repo-1",
      provider: "github",
      eventType: "pull_request",
      deliveryGuid: "abc-456",
      hostedMode: true,
      prNumber: 42,
    });

    expect(mocks.mockPrismaCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ prNumber: 42, hostedMode: true }),
    });
  });

  it("generates a non-empty id", async () => {
    mocks.mockPrismaCreate.mockImplementation((args: unknown) => {
      const { data } = args as { data: { id: string } };
      return Promise.resolve({ id: data.id });
    });

    const id = await createDeliveryLog({
      repoId: "repo-1",
      provider: "github",
      eventType: "push",
      deliveryGuid: "abc-789",
      hostedMode: false,
    });

    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("updateDeliveryStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates status and sets completedAt for terminal states", async () => {
    mocks.mockPrismaUpdate.mockResolvedValue({ id: "del-1" });

    await updateDeliveryStatus("del-1", "completed");

    expect(mocks.mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: "del-1" },
      data: expect.objectContaining({
        status: "completed",
        completedAt: expect.any(Date),
      }),
    });
  });

  it("sets error field when provided", async () => {
    mocks.mockPrismaUpdate.mockResolvedValue({ id: "del-2" });

    await updateDeliveryStatus("del-2", "failed", "Invalid HMAC signature");

    expect(mocks.mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: "del-2" },
      data: expect.objectContaining({
        status: "failed",
        error: "Invalid HMAC signature",
        completedAt: expect.any(Date),
      }),
    });
  });
});
