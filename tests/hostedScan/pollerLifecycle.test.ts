import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma", () => ({
  prisma: { repository: { findMany: vi.fn() } },
}));
vi.mock("../../src/services/hostedScan/orchestrator", () => ({
  triggerHostedScan: vi.fn(),
}));

import {
  startHostedPoller,
  stopHostedPoller,
} from "../../src/services/hostedScan/poller";

describe("startHostedPoller / stopHostedPoller", () => {
  afterEach(() => {
    stopHostedPoller();
    vi.useRealTimers();
  });

  it("starts an interval at the configured default", () => {
    vi.useFakeTimers();
    const pollSpy = vi.spyOn(global, "setInterval");

    startHostedPoller();

    expect(pollSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    pollSpy.mockRestore();
  });

  it("is idempotent and can be stopped", () => {
    vi.useFakeTimers();
    const pollSpy = vi.spyOn(global, "setInterval");

    startHostedPoller();
    startHostedPoller();
    expect(pollSpy).toHaveBeenCalledTimes(1);

    stopHostedPoller();
    vi.advanceTimersByTime(300_000);
    pollSpy.mockRestore();
  });
});
