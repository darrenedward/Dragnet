import { describe, expect, it } from "vitest";
import { evaluateCacheEligibility } from "../src/lib/cacheEligibility";

const base = {
  status: "completed", commitHash: "commit", diffHash: "diff", reviewConfigHash: "config", toolchainFingerprint: "toolchain", chunksTotal: 17,
};

describe("cache eligibility", () => {
  it("rejects a completed run with only 9 of 17 chunk records", () => {
    const result = evaluateCacheEligibility({
      run: base,
      current: { commitHash: "commit", diffHash: "diff", reviewConfigHash: "config", toolchainFingerprint: "toolchain" },
      chunks: Array.from({ length: 9 }, () => ({ status: "completed" })),
    });
    expect(result).toMatchObject({ eligible: false, reason: "incomplete_chunks" });
  });

  it("rejects contradictory chunk state even when the run says completed", () => {
    const result = evaluateCacheEligibility({
      run: base,
      current: { commitHash: "commit", diffHash: "diff", reviewConfigHash: "config", toolchainFingerprint: "toolchain" },
      chunks: Array.from({ length: 17 }, (_, index) => ({ status: index === 8 ? "pending" : "completed" })),
    });
    expect(result.reason).toBe("contradictory_chunks");
  });
});
