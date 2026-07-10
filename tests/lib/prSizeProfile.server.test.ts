import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockRunGitInRepo: vi.fn(),
}));

vi.mock("../../src/lib/repoAccess", () => ({
  runGitInRepo: mocks.mockRunGitInRepo,
}));

async function getMod() {
  return import("../../src/lib/prSizeProfile.server");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readPrCommitCount", () => {
  it("returns null when repo has no path and no cloneUrl", async () => {
    const { readPrCommitCount } = await getMod();
    const result = await readPrCommitCount({ id: "r1" }, "main", "feat");
    expect(result).toBeNull();
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns null when baseBranch is missing", async () => {
    const { readPrCommitCount } = await getMod();
    const result = await readPrCommitCount({ id: "r1", path: "/x" }, null, "feat");
    expect(result).toBeNull();
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns null when sourceBranch is missing", async () => {
    const { readPrCommitCount } = await getMod();
    const result = await readPrCommitCount({ id: "r1", path: "/x" }, "main", null);
    expect(result).toBeNull();
    expect(mocks.mockRunGitInRepo).not.toHaveBeenCalled();
  });

  it("returns parsed count on success (local-path mode)", async () => {
    const { readPrCommitCount } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "7\n", stderr: "", exitCode: 0 });
    const result = await readPrCommitCount({ id: "r1", path: "/x" }, "main", "feat");
    expect(result).toBe(7);
    expect(mocks.mockRunGitInRepo).toHaveBeenCalledWith(
      { id: "r1", path: "/x" },
      ["rev-list", "--count", "main...feat"],
    );
  });

  it("returns parsed count on success (remote-volume mode)", async () => {
    const { readPrCommitCount } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "12\n", stderr: "", exitCode: 0 });
    const result = await readPrCommitCount(
      { id: "r1", cloneUrl: "git@github.com:o/r.git" },
      "main",
      "feat",
    );
    expect(result).toBe(12);
    expect(mocks.mockRunGitInRepo).toHaveBeenCalledWith(
      expect.objectContaining({ cloneUrl: "git@github.com:o/r.git" }),
      ["rev-list", "--count", "main...feat"],
    );
  });

  it("returns null when git fails", async () => {
    const { readPrCommitCount } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "", stderr: "fatal: bad revision", exitCode: 128 });
    const result = await readPrCommitCount({ id: "r1", path: "/x" }, "main", "feat");
    expect(result).toBeNull();
  });

  it("returns null when stdout is not a number", async () => {
    const { readPrCommitCount } = await getMod();
    mocks.mockRunGitInRepo.mockResolvedValue({ stdout: "garbage\n", stderr: "", exitCode: 0 });
    const result = await readPrCommitCount({ id: "r1", path: "/x" }, "main", "feat");
    expect(result).toBeNull();
  });
});