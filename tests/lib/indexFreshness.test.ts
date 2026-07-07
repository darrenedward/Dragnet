import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRunGitInRepo: vi.fn(),
}));

vi.mock("../../src/lib/repoAccess", () => ({
  runGitInRepo: mocks.mockRunGitInRepo,
}));

import { assertIndexFresh, currentHeadCommit } from "../../src/lib/indexFreshness";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("currentHeadCommit", () => {
  it("returns the hash on git success", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "abc1234567890def\n", stderr: "", exitCode: 0 });
    const head = await currentHeadCommit({ id: "r1", path: "/x" });
    expect(head).toBe("abc1234567890def");
    expect(mocks.mockRunGitInRepo).toHaveBeenCalledWith(
      { id: "r1", path: "/x" },
      ["rev-parse", "HEAD"],
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it("returns null on non-zero exit", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "", stderr: "fatal: not a git repo", exitCode: 128 });
    const head = await currentHeadCommit({ id: "r1", path: "/x" });
    expect(head).toBeNull();
  });

  it("returns null on invalid hash format", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "not-a-hash\n", stderr: "", exitCode: 0 });
    const head = await currentHeadCommit({ id: "r1", path: "/x" });
    expect(head).toBeNull();
  });
});

describe("assertIndexFresh", () => {
  const baseRepo = {
    id: "r1",
    name: "Test",
    indexedAt: "2026-01-01T00:00:00Z",
    lastCommitHash: "abc1234567890def",
  };

  it("returns INDEX_REQUIRED when indexedAt is null", async () => {
    const result = await assertIndexFresh({ ...baseRepo, indexedAt: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("INDEX_REQUIRED");
  });

  it("returns ok when lastCommitHash is empty (legacy row, skipped)", async () => {
    const result = await assertIndexFresh({ ...baseRepo, lastCommitHash: "" });
    expect(result.ok).toBe(true);
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns ok when no path and no cloneUrl (nothing to read)", async () => {
    const result = await assertIndexFresh({ ...baseRepo, path: null, cloneUrl: null });
    expect(result.ok).toBe(true);
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns STALE_INDEX when current HEAD differs from lastCommitHash", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "deadbeef1234567890ab\n", stderr: "", exitCode: 0 });
    const result = await assertIndexFresh({ ...baseRepo, path: "/x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("STALE_INDEX");
    expect(result.message).toContain("stale");
    expect(result.message).toContain("abc1234");
    expect(result.message).toContain("deadbee");
  });

  it("returns ok when current HEAD matches lastCommitHash", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "abc1234567890def\n", stderr: "", exitCode: 0 });
    const result = await assertIndexFresh({ ...baseRepo, path: "/x" });
    expect(result.ok).toBe(true);
  });

  it("returns ok when git read fails (treats as 'can't verify, trust indexedAt')", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "", stderr: "fatal: not a git repo", exitCode: 128 });
    const result = await assertIndexFresh({ ...baseRepo, path: "/x" });
    expect(result.ok).toBe(true);
  });

  it("works for remote-volume repos (cloneUrl set, path null)", async () => {
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "abc1234567890def\n", stderr: "", exitCode: 0 });
    const result = await assertIndexFresh({
      ...baseRepo,
      path: null,
      cloneUrl: "git@github.com:o/r.git",
      cloneUrlHttps: "https://github.com/o/r.git",
    });
    expect(result.ok).toBe(true);
    expect(mocks.mockRunGitInRepo).toHaveBeenCalledWith(
      expect.objectContaining({ cloneUrl: "git@github.com:o/r.git", path: null }),
      ["rev-parse", "HEAD"],
      expect.any(Object),
    );
  });
});